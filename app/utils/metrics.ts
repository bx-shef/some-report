import type {
  ConversionBase,
  DealsContext,
  FunnelStage,
  LeadAggregate,
  JunkReasonRow,
  LossReasonRow,
  LostDealsMetrics,
  PreDealLossMetrics,
  ProcessingMetrics,
  ReportDeal,
  ReportLead,
  ReportMetrics,
  ReportOptions,
  SourceRow,
  SummaryMetrics
} from '~/types/report'

/**
 * Ядро отчёта: чистые функции, ни одного обращения к сети, SDK или времени (кроме явно
 * переданного `options.now`). Всё, что в отчёте — число, считается здесь и здесь же покрыто
 * тестами; компоненты только рисуют.
 *
 * ⚠ Ноль в знаменателе — не крайний случай, а НОРМА этого отчёта: пустой период, источник без
 * лидов, портал без проигранных сделок. Поэтому делим только через `share()`, которая возвращает
 * `0`, а не `NaN`/`Infinity`. Один `x / 0` в шаблоне выводит «NaN %» — и весь отчёт перестают
 * читать.
 */

/** Доля `part` от `whole` в виде дроби 0…1. Нулевой знаменатель даёт `0`, а не `NaN`. */
export function share(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return 0
  return part / whole
}

/**
 * Знаменатель конверсий.
 *
 * `quality-leads` (ТЗ) — Всего − Брак: «сколько из НОРМАЛЬНЫХ обращений дошло до сделки».
 * `all-leads` (макет) — все лиды: «сколько из ВСЕГО потока дошло до сделки».
 *
 * Обе величины осмысленны, но отвечают на разные вопросы, поэтому выбор вынесен наружу.
 * См. `docs/METRICS.md` § «Знаменатель конверсий».
 */
export function conversionBaseValue(totalLeads: number, junk: number, base: ConversionBase): number {
  return base === 'all-leads' ? totalLeads : Math.max(0, totalLeads - junk)
}

/** Лид — брак. Причина может быть не заполнена, на признак это не влияет. */
export function isJunk(lead: ReportLead): boolean {
  return lead.outcome === 'junk'
}

/**
 * Лид квалифицирован: по нему есть сделка И он не признан браком.
 *
 * ⚠ Второе условие — не перестраховка. Признаки были независимыми, и лид, по которому успели
 * завести сделку, а потом перевели в брак, попадал СРАЗУ В ОБА множества: из знаменателя его
 * вычитали как брак, а в числителе оставляли как квалифицированного — конверсия уезжала выше
 * 100 %, а «потери до сделки» вычитали его дважды. На живом портале такой лид — обычное дело:
 * брак отмечают задним числом.
 *
 * ⚠ ПРИОРИТЕТ У БРАКА, и это осознанный выбор: пометка «брак» — явное решение человека, а сделка
 * могла остаться от прежнего хода работы. Сама сделка при этом из выручки НЕ пропадает: деньги
 * реальны, и `summary.revenue` считает её наравне с прочими.
 */
export function isQualified(lead: ReportLead): boolean {
  return lead.dealIds.length > 0 && !isJunk(lead)
}

/**
 * Код причины для группировки. Незаполненную причину сводим в один явный код, а не выбрасываем:
 * «причина не указана» — тоже результат работы отдела, и чаще всего самый крупный.
 */
export const UNSPECIFIED_REASON = '__unspecified__'

/** Код источника для группировки. Пустой `SOURCE_ID` — «Другие источники» на макете. */
export const UNSPECIFIED_SOURCE = '__unspecified__'

function reasonKey(id: string | undefined): string {
  return id && id.trim() ? id : UNSPECIFIED_REASON
}

function sourceKey(id: string | undefined): string {
  return id && id.trim() ? id : UNSPECIFIED_SOURCE
}

/**
 * Свернуть строки лидов в агрегат.
 *
 * Это ЕДИНСТВЕННОЕ место, где ядро смотрит на отдельные лиды. Все формулы ниже принимают
 * агрегат, потому что на боевом портале строк 3 851 в месяц и выбирать их 42 секунды, а портал
 * умеет считать сам — см. `LeadAggregate`. Демо-набор и тесты идут через эту функцию, живой
 * портал приносит агрегат напрямую; оба пути обязаны сходиться, и это закреплено тестом.
 */
export function aggregateLeads(leads: ReportLead[], options: ReportOptions): LeadAggregate {
  const junkByReason: Record<string, number> = Object.create(null)
  const bySource: Record<string, { leads: number, junk: number, qualified: number }> = Object.create(null)
  const leadSourceById: Record<number, string> = Object.create(null)
  let junk = 0
  let qualified = 0
  let inWork = 0

  for (const lead of leads) {
    const source = sourceKey(lead.sourceId)
    const row = bySource[source] ?? (bySource[source] = { leads: 0, junk: 0, qualified: 0 })
    row.leads += 1
    leadSourceById[lead.id] = source
    if (isJunk(lead)) {
      junk += 1
      row.junk += 1
      const reason = reasonKey(lead.junkReasonId)
      junkByReason[reason] = (junkByReason[reason] ?? 0) + 1
    } else if (isQualified(lead)) {
      qualified += 1
      row.qualified += 1
    } else if (lead.outcome === 'in-work') {
      inWork += 1
    }
  }

  return {
    total: leads.length,
    junk,
    qualified,
    inWork,
    closedWithoutDeal: Math.max(0, leads.length - junk - qualified - inWork),
    junkByReason,
    bySource,
    leadSourceById,
    processing: processingMetrics(leads, options)
  }
}

/** Сводка (KPI). */
export function summaryMetrics(
  leads: LeadAggregate,
  deals: ReportDeal[],
  options: ReportOptions,
  allDeals?: DealsContext
): SummaryMetrics {
  const won = deals.filter(d => d.outcome === 'won')
  const baseValue = conversionBaseValue(leads.total, leads.junk, options.conversionBase)

  return {
    totalLeads: leads.total,
    junk: leads.junk,
    junkShare: share(leads.junk, leads.total),
    qualified: leads.qualified,
    qualifiedShare: share(leads.qualified, baseValue),
    wonDeals: won.length,
    wonShare: share(won.length, baseValue),
    revenue: won.reduce((sum, d) => sum + d.amount, 0),
    conversionBase: options.conversionBase,
    conversionBaseValue: baseValue,
    allDeals
  }
}

/** Воронка: Лиды → Квалифицировано → Успешные сделки. */
export function funnelStages(summary: SummaryMetrics): FunnelStage[] {
  return [
    {
      // ⚠ Доля ВХОДА воронки считается от неё самой, то есть всегда 100 %. Наивное
      // «от знаменателя конверсий» при базе ТЗ давало 1250 / 1000 = 125 % — воронку, которая
      // начинается со ста двадцати пяти процентов.
      key: 'leads',
      label: 'Лиды',
      count: summary.totalLeads,
      share: share(summary.totalLeads, summary.totalLeads)
    },
    {
      key: 'qualified',
      label: 'Квалифицировано в сделку',
      count: summary.qualified,
      share: summary.qualifiedShare
    },
    {
      key: 'won',
      label: 'Успешная сделка',
      count: summary.wonDeals,
      share: summary.wonShare
    }
  ]
}

/** Разница дат в минутах. Отрицательную (ответ «раньше создания») считаем нулём. */
function minutesBetween(fromIso: string, toIso: string): number | undefined {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined
  return Math.max(0, (to - from) / 60000)
}

/**
 * Обработка лидов.
 *
 * Обработанный — тот, по которому есть первое действие (`firstResponseAt`). Просроченный — тот,
 * у кого первый ответ позже норматива, ЛИБО ответа ещё нет, а норматив уже вышел. Второй случай
 * важнее первого: именно про лиды, которых не коснулись вовсе, руководитель и спрашивает.
 */
export function processingMetrics(leads: ReportLead[], options: ReportOptions): ProcessingMetrics {
  const total = leads.length
  const answered = leads.filter(l => Boolean(l.firstResponseAt))
  const durations = answered
    .map(l => minutesBetween(l.createdAt, l.firstResponseAt!))
    .filter((m): m is number => m !== undefined)

  const sla = options.firstResponseSlaMinutes
  const nowMs = options.now ? Date.parse(options.now) : Number.NaN

  let overdue: number | undefined
  if (sla !== undefined) {
    overdue = leads.filter((l) => {
      if (l.firstResponseAt) {
        const m = minutesBetween(l.createdAt, l.firstResponseAt)
        return m !== undefined && m > sla
      }
      // Ответа не было. Просрочен, только если норматив УЖЕ истёк: свежий лид без ответа —
      // ещё не нарушение. Без известного «сейчас» такой лид не судим.
      if (!Number.isFinite(nowMs)) return false
      const created = Date.parse(l.createdAt)
      return Number.isFinite(created) && (nowMs - created) / 60000 > sla
    }).length
  }

  const bySourceMap = new Map<string, { processed: number, sum: number, n: number }>()
  for (const lead of answered) {
    const key = sourceKey(lead.sourceId)
    const acc = bySourceMap.get(key) ?? { processed: 0, sum: 0, n: 0 }
    acc.processed += 1
    const m = minutesBetween(lead.createdAt, lead.firstResponseAt!)
    if (m !== undefined) {
      acc.sum += m
      acc.n += 1
    }
    bySourceMap.set(key, acc)
  }

  return {
    processed: answered.length,
    processedShare: share(answered.length, total),
    unprocessed: total - answered.length,
    unprocessedShare: share(total - answered.length, total),
    overdue,
    overdueShare: overdue === undefined ? undefined : share(overdue, total),
    avgFirstResponseMinutes: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : undefined,
    bySource: [...bySourceMap.entries()]
      .map(([sourceId, acc]) => ({
        sourceId,
        processed: acc.processed,
        avgFirstResponseMinutes: acc.n ? acc.sum / acc.n : undefined
      }))
      .sort((a, b) => b.processed - a.processed || a.sourceId.localeCompare(b.sourceId))
  }
}

/**
 * Обработка лидов по ДВУМ счётчикам портала: всего и «до сих пор в „Не обработан“».
 *
 * Время первого ответа и просрочка требуют истории стадий и приходят позже, из
 * `processingMetrics` по строкам; до этого поля пусты, и блок говорит, что считает.
 */
export function processingFromCounts(total: number, unprocessed: number): ProcessingMetrics {
  const safeTotal = Math.max(0, total)
  const safeUnprocessed = Math.min(Math.max(0, unprocessed), safeTotal)
  const processed = safeTotal - safeUnprocessed
  return {
    processed,
    processedShare: share(processed, safeTotal),
    unprocessed: safeUnprocessed,
    unprocessedShare: share(safeUnprocessed, safeTotal),
    bySource: []
  }
}

/**
 * Совместить счётчики и расчёт по истории: числа «обработано / не обработано» — от счётчиков
 * портала (они точнее и уже на экране), время, просрочка и разрез по источникам — из истории.
 *
 * ⚠ Не заменять целиком: история берётся с запасом в несколько дней после периода, и её
 * «обработано» на границе месяца отличается от счётчика на несколько лидов. Две разные цифры
 * под одной подписью с интервалом в минуту — ровно то, чего этот отчёт избегает.
 */
export function mergeProcessing(counts: ProcessingMetrics, timed: ProcessingMetrics): ProcessingMetrics {
  return {
    ...counts,
    ...(timed.overdue === undefined ? {} : { overdue: timed.overdue, overdueShare: timed.overdueShare }),
    ...(timed.avgFirstResponseMinutes === undefined ? {} : { avgFirstResponseMinutes: timed.avgFirstResponseMinutes }),
    bySource: timed.bySource
  }
}

/** Разбивка брака по причинам. Сортировка — по убыванию количества (крупное первым). */
export function junkByReason(leads: LeadAggregate): JunkReasonRow[] {
  return Object.entries(leads.junkByReason)
    .map(([reasonId, count]) => ({
      reasonId,
      count,
      shareOfLeads: share(count, leads.total),
      shareOfJunk: share(count, leads.junk)
    }))
    .sort((a, b) => b.count - a.count || a.reasonId.localeCompare(b.reasonId))
}

/**
 * Потери до сделки.
 *
 * ⚠ Формула ТЗ (Всего − Брак − Квалифицировано) засчитывает в потери и лиды, которые ещё в
 * работе. Считаем ровно по ТЗ, но раскладываем на «ещё в работе» и «закрыт без сделки», чтобы
 * завышение было видно, а не подразумевалось.
 */
export function preDealLoss(leads: LeadAggregate, summary: SummaryMetrics): PreDealLossMetrics {
  const count = Math.max(0, summary.totalLeads - summary.junk - summary.qualified)
  const stillInWork = Math.min(count, leads.inWork)
  // Открытые лиды по стадиям — только со счётчиков портала; сортировка по убыванию, потом по коду.
  const byStage = leads.byOpenStage
    ? Object.entries(leads.byOpenStage)
        .map(([stageId, n]) => ({ stageId, count: n }))
        .sort((a, b) => b.count - a.count || a.stageId.localeCompare(b.stageId))
    : undefined
  return {
    count,
    share: share(count, summary.conversionBaseValue),
    stillInWork,
    closedWithoutDeal: Math.max(0, count - stillInWork),
    ...(byStage ? { byStage } : {})
  }
}

/** Проигранные сделки и разбивка по причинам. */
export function lostDeals(deals: ReportDeal[], summary: SummaryMetrics): LostDealsMetrics {
  const lost = deals.filter(d => d.outcome === 'lost')
  const lostRevenue = lost.reduce((sum, d) => sum + d.amount, 0)

  const acc = new Map<string, { count: number, revenue: number }>()
  for (const deal of lost) {
    const key = reasonKey(deal.lossReasonId)
    const row = acc.get(key) ?? { count: 0, revenue: 0 }
    row.count += 1
    row.revenue += deal.amount
    acc.set(key, row)
  }

  const byReason: LossReasonRow[] = [...acc.entries()]
    .map(([reasonId, row]) => ({
      reasonId,
      count: row.count,
      shareOfLost: share(row.count, lost.length),
      lostRevenue: row.revenue,
      shareOfLostRevenue: share(row.revenue, lostRevenue)
    }))
    .sort((a, b) => b.count - a.count || a.reasonId.localeCompare(b.reasonId))

  return {
    count: lost.length,
    shareOfQualified: share(lost.length, summary.qualified),
    lostRevenue,
    byReason
  }
}

/**
 * Эффективность источников.
 *
 * Источник берётся У ЛИДА, а не у сделки: сделка может унаследовать пустой источник или получить
 * свой при ручном заведении, и тогда одна и та же продажа попала бы в две строки. Сделки без
 * лида-родителя в этот блок не входят вовсе — их источник неизвестен, а выдумывать его нельзя.
 */
export function sourceRows(
  leads: LeadAggregate,
  deals: ReportDeal[],
  options: ReportOptions
): SourceRow[] {
  const acc = new Map<string, { leads: number, junk: number, qualified: number, won: number, revenue: number }>()
  for (const [sourceId, row] of Object.entries(leads.bySource)) {
    acc.set(sourceId, { ...row, won: 0, revenue: 0 })
  }

  for (const deal of deals) {
    if (deal.outcome !== 'won' || deal.leadId === undefined) continue
    /**
     * Источник сделки: у ЛИДА, когда лиды известны построчно; иначе — у самой сделки.
     *
     * ⚠ Второе — не компромисс наугад: при конвертации лида Битрикс24 копирует `SOURCE_ID` в
     * сделку, так что для сделки ИЗ ЛИДА это тот же источник. А вот сделка, чей лид известен,
     * но в выборку не попал (создан до периода, удалён), в разрез не входит — иначе выручка
     * легла бы на источник, которого в таблице лидов нет, и итоги разошлись бы со сводкой.
     */
    const sourceId = leads.leadSourceById
      ? leads.leadSourceById[deal.leadId]
      : sourceKey(deal.sourceId)
    if (sourceId === undefined) continue
    // ⚠ Источник без единого лида за период строки не получает — ни в одном из режимов. Иначе
    // сделка по лиду прошлого месяца рисовала бы строку «лидов 0, успешных 1, конверсия 0 %», а
    // при одном лиде и трёх таких сделках — конверсию 300 %.
    const row = acc.get(sourceId)
    if (!row) continue
    row.won += 1
    row.revenue += deal.amount
  }

  return [...acc.entries()]
    .map(([sourceId, row]) => {
      const base = conversionBaseValue(row.leads, row.junk, options.conversionBase)
      return {
        sourceId,
        leads: row.leads,
        junk: row.junk,
        junkShare: share(row.junk, row.leads),
        qualified: row.qualified,
        crToDeal: share(row.qualified, base),
        won: row.won,
        crToSale: share(row.won, base),
        revenue: row.revenue
      }
    })
    .sort((a, b) => b.leads - a.leads || a.sourceId.localeCompare(b.sourceId))
}

/** Топ-5 источников по количеству лидов. */
export function topSources(rows: SourceRow[], limit = 5): SourceRow[] {
  return rows.slice(0, limit)
}

/**
 * Полный расчёт отчёта из агрегата лидов и строк сделок.
 *
 * Строки сделок — только те, что ИЗ ЛИДОВ: отчёт про путь лида, и сделки без лида-родителя в
 * воронку не входят. Их число за период приходит отдельно, в `allDeals`, — чтобы «успешных
 * сделок: 636» не читалось как «компания продала 636 раз».
 */
export function buildReportFromAggregate(
  leads: LeadAggregate,
  deals: ReportDeal[],
  options: ReportOptions,
  allDeals?: DealsContext
): ReportMetrics {
  const summary = summaryMetrics(leads, deals, options, allDeals)
  const bySource = sourceRows(leads, deals, options)
  return {
    summary,
    funnel: funnelStages(summary),
    processing: leads.processing,
    junkByReason: junkByReason(leads),
    preDealLoss: preDealLoss(leads, summary),
    lostDeals: lostDeals(deals, summary),
    bySource,
    topSources: topSources(bySource)
  }
}

/** Полный расчёт отчёта из нормализованных лидов и сделок — демо-набор и тесты. */
export function buildReport(
  leads: ReportLead[],
  deals: ReportDeal[],
  options: ReportOptions
): ReportMetrics {
  return buildReportFromAggregate(aggregateLeads(leads, options), deals, options)
}
