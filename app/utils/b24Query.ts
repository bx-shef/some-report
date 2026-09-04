import type { ReportPeriod } from '~/types/report'
import { dealCountKey, leadCountKey, unlinkedDealKey } from '~/utils/b24Adapter'

/**
 * Запросы к порталу: что именно спрашиваем у CRM за период отчёта.
 *
 * Модуль чистый и потому под тестами: ошибка в списке полей или в границах периода не даёт ни
 * исключения, ни пустого экрана — отчёт просто считает не то, что нужно, и выглядит при этом
 * совершенно правдоподобно. Ровно этот класс ошибок здесь и сторожим.
 *
 * ⚠ Ходим КЛАССИЧЕСКИМИ `crm.lead.list` / `crm.deal.list`, а не универсальным `crm.item.list`:
 * у него для лидов `STATUS_ID` приезжает под именем `stageId`, а неизвестное поле в `select` он
 * принимает без ошибки и просто возвращает записи без него. Отчёт посчитал бы все лиды
 * «в работе» и не подал ни одного сигнала (`docs/PORTAL.md`).
 */

/**
 * Поля лида. Каждое здесь нужно ядру:
 * `STATUS_SEMANTIC_ID` — брак или нет, `SOURCE_ID` — разрез по источникам,
 * `ASSIGNED_BY_ID` — ответственный, `DATE_CREATE` — период.
 */
export const LEAD_SELECT = ['ID', 'STATUS_ID', 'STATUS_SEMANTIC_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE'] as const

/** Поля сделки. `LEAD_ID` — та самая связь, без которой не собирается воронка. */
export const DEAL_SELECT = ['ID', 'LEAD_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'CURRENCY_ID'] as const

/**
 * Следующий день в формате `YYYY-MM-DD`.
 *
 * ⚠ Нужен для ВЕРХНЕЙ границы периода, и это не придирка. Битрикс24 сравнивает `DATE_CREATE` как
 * дату-время, поэтому `<=DATE_CREATE: '2026-09-30'` означает «до полуночи 30-го» и молча
 * выбрасывает весь последний день периода. Отчёт при этом не ломается — просто недосчитывает
 * лиды за последние сутки, и заметить это можно только сверкой с CRM вручную.
 */
export function nextDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return date
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

/** Границы периода для фильтра REST по дате создания. */
export function periodFilter(period: ReportPeriod, field = 'DATE_CREATE'): Record<string, string> {
  return {
    [`>=${field}`]: period.from,
    [`<${field}`]: nextDay(period.to)
  }
}

/** Параметры `crm.lead.list` за период. */
export function leadListParams(period: ReportPeriod) {
  return { select: [...LEAD_SELECT], filter: periodFilter(period) }
}

/**
 * Параметры `crm.deal.list` за период.
 *
 * ⚠ Сделки берём по ИХ СОБСТВЕННОЙ дате создания. Это осознанное упрощение с известным краем:
 * сделка, созданная по лиду конца периода уже в следующем месяце, в выборку не попадёт, и
 * конверсия за период окажется занижена. Точный вариант — добирать сделки по `LEAD_ID` выбранных
 * лидов, но пока в портале заказчика связи лид → сделка нет вовсе (ждём бизнес-процесс, см. #12),
 * и городить это не на чем: проверить правильность было бы не на чем.
 */
export function dealListParams(period: ReportPeriod) {
  return { select: [...DEAL_SELECT], filter: periodFilter(period) }
}

/**
 * Справочники портала одним пакетом.
 *
 * Их четыре и они маленькие — отдельными запросами это четыре круга по сети вместо одного.
 * Названия команд совпадают с полями `AdapterInput`, чтобы разбор ответа не превращался в
 * перекладывание по индексам.
 */
export function dictionaryBatch() {
  return {
    currencies: { method: 'crm.currency.list', params: {} },
    sources: { method: 'crm.status.list', params: { filter: { ENTITY_ID: 'SOURCE' } } },
    leadStatuses: { method: 'crm.status.list', params: { filter: { ENTITY_ID: 'STATUS' } } },
    dealStages: { method: 'crm.status.list', params: { filter: { ENTITY_ID: 'DEAL_STAGE' } } }
  }
}

/**
 * Параметры «когда в портале был последний лид».
 *
 * ⚠ Нужны, чтобы пустой отчёт не выглядел сломанным. Открыть отчёт 3-го числа и увидеть нули —
 * ровно та ситуация, в которой человек решает, что приложение врёт. Разница между «в портале нет
 * лидов» и «в ЭТОМ периоде нет лидов, последний был 17.08» — это разница между «сломалось» и
 * «поменяйте период», и стоит она одного запроса на одну запись.
 *
 * Здесь нужен обычный `call`, а не постраничная выборка: `order` в ней недоступен, потому что
 * она сама сортирует по `ID`.
 */
export function latestLeadParams() {
  return { select: ['ID', 'DATE_CREATE'], order: { DATE_CREATE: 'DESC' }, start: 0 }
}

/** Одна команда пакета: метод и параметры. */
export interface BatchCommand {
  method: string
  params: Record<string, unknown>
}

/** Запрос «сколько записей» — только `total`, без единой строки данных. */
function countCommand(method: string, filter: Record<string, unknown>): BatchCommand {
  return { method, params: { select: ['ID'], filter, start: 0 } }
}

/**
 * Пакет счётчиков лидов за период.
 *
 * ⚠ Зачем счётчики вместо строк — объёмы. На боевом портале 3 851 лид в месяц: 78 страниц по
 * 0,54 с ≈ 42 секунды. Здесь ~50 вопросов «сколько», которые портал считает индексом, — одним
 * пакетом это две секунды. Ключи команд задаёт `leadCountKey`: тот же словарь читает и
 * `adaptLeadCounts`, поэтому разъехаться им негде.
 *
 * ⚠ «Источник не указан» не спрашивается — вычисляется остатком в адаптере.
 */
export function leadCountBatch(
  period: ReportPeriod,
  dictionaries: { junkStatusIds: readonly string[], sourceIds: readonly string[] }
): Record<string, BatchCommand> {
  const base = periodFilter(period)
  const method = 'crm.lead.list'
  const commands: Record<string, BatchCommand> = {
    [leadCountKey.total]: countCommand(method, base),
    [leadCountKey.junk]: countCommand(method, { ...base, STATUS_SEMANTIC_ID: 'F' }),
    [leadCountKey.converted]: countCommand(method, { ...base, STATUS_SEMANTIC_ID: 'S' }),
    [leadCountKey.inWork]: countCommand(method, { ...base, STATUS_SEMANTIC_ID: 'P' })
  }
  for (const statusId of dictionaries.junkStatusIds) {
    commands[leadCountKey.junkReason(statusId)] = countCommand(method, { ...base, STATUS_ID: statusId })
  }
  for (const sourceId of dictionaries.sourceIds) {
    commands[leadCountKey.source(sourceId)] = countCommand(method, { ...base, SOURCE_ID: sourceId })
    commands[leadCountKey.sourceJunk(sourceId)] = countCommand(method, { ...base, SOURCE_ID: sourceId, STATUS_SEMANTIC_ID: 'F' })
    commands[leadCountKey.sourceConverted(sourceId)] = countCommand(method, { ...base, SOURCE_ID: sourceId, STATUS_SEMANTIC_ID: 'S' })
  }
  return commands
}

/** Сделки всего портала за период — три счётчика для контекста сводки. */
export function dealContextBatch(period: ReportPeriod): Record<string, BatchCommand> {
  const base = periodFilter(period)
  const method = 'crm.deal.list'
  return {
    [dealCountKey.won]: countCommand(method, { ...base, STAGE_SEMANTIC_ID: 'S' }),
    [dealCountKey.lost]: countCommand(method, { ...base, STAGE_SEMANTIC_ID: 'F' }),
    [dealCountKey.inWork]: countCommand(method, { ...base, STAGE_SEMANTIC_ID: 'P' })
  }
}

/**
 * Сделки без связи с лидом за период — счётчиками, по источникам.
 *
 * ⚠ `LEAD_ID: ''` — так портал понимает «поле пусто» (проверено на боевом портале: 9 191 из
 * 10 178 за август). Два счётчика на источник (всего и успешных) плюс строка «источник пуст»
 * и все сделки периода для доли — порядка 60 команд, два пакета. Строк не читаем: тут нужно
 * только «сколько», и ради этого 180 страниц по 0,54 с никто ждать не будет.
 */
export function unlinkedDealBatch(period: ReportPeriod, sourceIds: readonly string[]): Record<string, BatchCommand> {
  const base = periodFilter(period)
  const method = 'crm.deal.list'
  const unlinked = { ...base, LEAD_ID: '' }
  const commands: Record<string, BatchCommand> = {
    [unlinkedDealKey.allDeals]: countCommand(method, base),
    [unlinkedDealKey.total]: countCommand(method, unlinked),
    [unlinkedDealKey.won]: countCommand(method, { ...unlinked, STAGE_SEMANTIC_ID: 'S' }),
    [unlinkedDealKey.noSource]: countCommand(method, { ...unlinked, SOURCE_ID: '' }),
    [unlinkedDealKey.noSourceWon]: countCommand(method, { ...unlinked, SOURCE_ID: '', STAGE_SEMANTIC_ID: 'S' })
  }
  for (const sourceId of sourceIds) {
    commands[unlinkedDealKey.source(sourceId)] = countCommand(method, { ...unlinked, SOURCE_ID: sourceId })
    commands[unlinkedDealKey.sourceWon(sourceId)] = countCommand(method, { ...unlinked, SOURCE_ID: sourceId, STAGE_SEMANTIC_ID: 'S' })
  }
  return commands
}

/**
 * Сделки ИЗ ЛИДОВ за период — строками.
 *
 * ⚠ Только они, а не все сделки: на боевом портале сделок 10 178 в месяц (204 страницы, почти
 * две минуты), а с заполненным `LEAD_ID` — 987 (20 страниц, ~10 секунд). Отчёт про путь лида, и
 * ровно эти сделки ему нужны построчно — ради выручки и причин проигрыша. Остальные приходят
 * счётчиками, см. `dealContextBatch`.
 */
export function dealsFromLeadsParams(period: ReportPeriod) {
  return { select: [...DEAL_SELECT], filter: { ...periodFilter(period), '!LEAD_ID': null } }
}

/** Направления сделок: их справочники стадий лежат отдельно, по одному на направление. */
export function categoryListParams() {
  return { entityTypeId: 2 }
}

/**
 * Справочники стадий сделок ВСЕХ направлений одним пакетом.
 *
 * ⚠ `ENTITY_ID: DEAL_STAGE` — это только направление по умолчанию. У заказчика их четыре, и
 * стадии остальных лежат в `DEAL_STAGE_<id>`: без них причина проигрыша из второго направления
 * приедет кодом вместо названия.
 */
export function dealStageBatch(categoryIds: readonly number[]): Record<string, BatchCommand> {
  const commands: Record<string, BatchCommand> = {
    default: { method: 'crm.status.list', params: { filter: { ENTITY_ID: 'DEAL_STAGE' } } }
  }
  for (const id of categoryIds) {
    if (id <= 0) continue
    commands[`c${id}`] = { method: 'crm.status.list', params: { filter: { ENTITY_ID: `DEAL_STAGE_${id}` } } }
  }
  return commands
}
