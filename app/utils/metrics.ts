import type {
  ConversionBase,
  FunnelStage,
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

/** Сводка (KPI). */
export function summaryMetrics(
  leads: ReportLead[],
  deals: ReportDeal[],
  options: ReportOptions
): SummaryMetrics {
  const totalLeads = leads.length
  const junk = leads.filter(isJunk).length
  const qualified = leads.filter(isQualified).length
  const won = deals.filter(d => d.outcome === 'won')
  const baseValue = conversionBaseValue(totalLeads, junk, options.conversionBase)

  return {
    totalLeads,
    junk,
    junkShare: share(junk, totalLeads),
    qualified,
    qualifiedShare: share(qualified, baseValue),
    wonDeals: won.length,
    wonShare: share(won.length, baseValue),
    revenue: won.reduce((sum, d) => sum + d.amount, 0),
    conversionBase: options.conversionBase,
    conversionBaseValue: baseValue
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

/** Разбивка брака по причинам. Сортировка — по убыванию количества (крупное первым). */
export function junkByReason(leads: ReportLead[]): JunkReasonRow[] {
  const junk = leads.filter(isJunk)
  const counts = new Map<string, number>()
  for (const lead of junk) {
    const key = reasonKey(lead.junkReasonId)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reasonId, count]) => ({
      reasonId,
      count,
      shareOfLeads: share(count, leads.length),
      shareOfJunk: share(count, junk.length)
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
export function preDealLoss(leads: ReportLead[], summary: SummaryMetrics): PreDealLossMetrics {
  const count = Math.max(0, summary.totalLeads - summary.junk - summary.qualified)
  const stillInWork = leads.filter(l => !isJunk(l) && !isQualified(l) && l.outcome === 'in-work').length
  return {
    count,
    share: share(count, summary.conversionBaseValue),
    stillInWork,
    closedWithoutDeal: Math.max(0, count - stillInWork)
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
  leads: ReportLead[],
  deals: ReportDeal[],
  options: ReportOptions
): SourceRow[] {
  const dealById = new Map(deals.map(d => [d.id, d]))
  const acc = new Map<string, { leads: number, junk: number, qualified: number, won: number, revenue: number }>()

  for (const lead of leads) {
    const key = sourceKey(lead.sourceId)
    const row = acc.get(key) ?? { leads: 0, junk: 0, qualified: 0, won: 0, revenue: 0 }
    row.leads += 1
    if (isJunk(lead)) row.junk += 1
    if (isQualified(lead)) row.qualified += 1
    for (const dealId of lead.dealIds) {
      const deal = dealById.get(dealId)
      if (deal?.outcome === 'won') {
        row.won += 1
        row.revenue += deal.amount
      }
    }
    acc.set(key, row)
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

/** Полный расчёт отчёта из нормализованных лидов и сделок. */
export function buildReport(
  leads: ReportLead[],
  deals: ReportDeal[],
  options: ReportOptions
): ReportMetrics {
  const summary = summaryMetrics(leads, deals, options)
  const bySource = sourceRows(leads, deals, options)
  return {
    summary,
    funnel: funnelStages(summary),
    processing: processingMetrics(leads, options),
    junkByReason: junkByReason(leads),
    preDealLoss: preDealLoss(leads, summary),
    lostDeals: lostDeals(deals, summary),
    bySource,
    topSources: topSources(bySource)
  }
}
