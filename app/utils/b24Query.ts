import type { ReportPeriod } from '~/types/report'

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
 * Период по умолчанию — текущий календарный месяц.
 *
 * Отчёт открывают, чтобы посмотреть, как идут дела СЕЙЧАС. Редактируемый период — отдельная
 * задача (#4); до неё показываем месяц, в котором находимся, а не зашитые даты макета.
 */
export function currentMonthPeriod(now: Date): ReportPeriod {
  const year = now.getFullYear()
  const month = now.getMonth()
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(new Date(year, month, 1)), to: iso(new Date(year, month + 1, 0)) }
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
