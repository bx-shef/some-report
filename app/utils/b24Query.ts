import type { ReportPeriod } from '~/types/report'
import { dealCountKey, leadCountKey } from '~/utils/b24Adapter'
import { INITIAL_LEAD_STATUS } from '~/utils/leadHistory'

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
 * лидов. На боевом портале `LEAD_ID` заполнен у 10 % сделок, и это факт о процессе клиента, а не
 * то, чего ждёт отчёт (блок 7, #12); в режиме счётчиков этот параметр не используется вовсе.
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
  dictionaries: {
    junkStatusIds: readonly string[]
    sourceIds: readonly string[]
    /**
     * Открытые стадии лида (без семантики «успех»/«провал»), включая `NEW`. По ним — «Не
     * обработано» (счётчик `NEW`) и разбивка открытых лидов по стадиям для блока 6.
     */
    openStatusIds?: readonly string[]
  }
): Record<string, BatchCommand> {
  const base = periodFilter(period)
  const method = 'crm.lead.list'
  const commands: Record<string, BatchCommand> = {
    [leadCountKey.total]: countCommand(method, base),
    [leadCountKey.junk]: countCommand(method, { ...base, STATUS_SEMANTIC_ID: 'F' }),
    [leadCountKey.converted]: countCommand(method, { ...base, STATUS_SEMANTIC_ID: 'S' }),
    [leadCountKey.inWork]: countCommand(method, { ...base, STATUS_SEMANTIC_ID: 'P' }),
    // «Не обработано» — лиды, которые до сих пор в `NEW`. Обработано = всего − это число:
    // решение владельца от 2026-09-04, «ушёл со стадии „Не обработан“ — обработан».
    [leadCountKey.unprocessed]: countCommand(method, { ...base, STATUS_ID: INITIAL_LEAD_STATUS })
  }
  for (const statusId of dictionaries.junkStatusIds) {
    commands[leadCountKey.junkReason(statusId)] = countCommand(method, { ...base, STATUS_ID: statusId })
  }
  for (const statusId of dictionaries.openStatusIds ?? []) {
    commands[leadCountKey.stage(statusId)] = countCommand(method, { ...base, STATUS_ID: statusId })
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

/** Строка лида для истории стадий: когда создан, откуда, где сейчас. */
export const LEAD_HISTORY_LEAD_SELECT = ['ID', 'DATE_CREATE', 'SOURCE_ID', 'STATUS_ID'] as const

/** Лиды периода — строками, только для расчёта времени первого ответа (см. `leadHistoryParams`). */
export function leadHistoryLeadParams(period: ReportPeriod) {
  return { select: [...LEAD_HISTORY_LEAD_SELECT], filter: periodFilter(period) }
}

/** Поля записи истории: чей лид, куда перешёл и когда. Создание (`TYPE_ID = 1`) не берём — см. фильтр. */
export const LEAD_HISTORY_SELECT = ['ID', 'TYPE_ID', 'OWNER_ID', 'CREATED_TIME', 'STATUS_ID'] as const

/**
 * История стадий лидов — переходы и закрытия (`TYPE_ID` 2 и 3) с начала периода и ещё
 * `graceDays` после его конца.
 *
 * ⚠ Запас после конца периода — не роскошь: лид, созданный 31-го, берут в работу 1-го, и без
 * запаса он числился бы необработанным навсегда. Записи создания (`TYPE_ID = 1`) не нужны:
 * дата создания уже есть в строке лида, а это треть всех записей.
 *
 * ⚠ Фильтр по `CREATED_TIME` этот метод понимает ТОЛЬКО в JSON-теле запроса: в form-data он
 * молча игнорируется и отдаёт всю историю портала (466 479 записей на боевом, замер 2026-09-04).
 * SDK шлёт JSON — но при любой замене транспорта это первое, что нужно перепроверить.
 * Объём: ≈ 5 900 записей в месяц на боевом портале плюс ≈ 3 850 строк лидов — около двух минут.
 */
export function leadHistoryParams(period: ReportPeriod, graceDays = 3) {
  const [year, month, day] = period.to.split('-').map(Number)
  const end = new Date(year!, month! - 1, day! + graceDays)
  const endIso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
  return {
    entityTypeId: 1,
    select: [...LEAD_HISTORY_SELECT],
    filter: { ...periodFilter({ from: period.from, to: endIso }, 'CREATED_TIME'), TYPE_ID: [2, 3] }
  }
}

/**
 * Поля успешной сделки без лида: источник и деньги. Стадия, лид и дата закрытия уже в фильтре —
 * `CLOSEDATE` в выборку не берём: строк ≈ 5 500 в месяц, каждое лишнее поле — лишний трафик.
 */
export const UNLINKED_DEAL_SELECT = ['ID', 'SOURCE_ID', 'OPPORTUNITY', 'CURRENCY_ID'] as const

/**
 * Успешные сделки БЕЗ лида, закрытые в периоде, — строками.
 *
 * ⚠ Период здесь по `CLOSEDATE`, а не по дате создания, как во всём остальном отчёте. Это
 * решение владельца от 2026-09-04: блок — справка «сколько денег прошло мимо лидов за период»,
 * и для денег важен момент закрытия. Строк ≈ 5 500 в месяц на боевом портале (около минуты),
 * поэтому выборка идёт фоном после основного отчёта, а не внутри него.
 *
 * `LEAD_ID: ''` — так портал понимает «поле пусто» (проверено на боевом портале: 9 191 из 10 178
 * за август, ровно разность «все − с лидом»).
 */
export function unlinkedWonDealsParams(period: ReportPeriod) {
  return {
    select: [...UNLINKED_DEAL_SELECT],
    filter: { ...periodFilter(period, 'CLOSEDATE'), LEAD_ID: '', STAGE_SEMANTIC_ID: 'S' }
  }
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
