import { describe, expect, it } from 'vitest'
import { buildMockDataset } from '~/utils/mockReport'
import { buildReport } from '~/utils/metrics'

/**
 * Демо-набор — это ещё и живая проверка ядра: цифры с согласованного макета должны получаться
 * ИЗ ДАННЫХ, а не подставляться в шаблон. Если формула поедет, поедет и этот тест.
 */
describe('демо-набор воспроизводит согласованный макет', () => {
  const dataset = buildMockDataset()
  const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'all-leads' })

  it('сводка совпадает с макетом', () => {
    expect(report.summary).toMatchObject({
      totalLeads: 1250,
      junk: 250,
      qualified: 1000,
      wonDeals: 620,
      revenue: 485_000
    })
    expect(report.summary.junkShare).toBe(0.2)
    expect(report.summary.qualifiedShare).toBe(0.8)
    expect(report.summary.wonShare).toBeCloseTo(0.496, 10)
  })

  it('разбивка брака совпадает с макетом', () => {
    expect(report.junkByReason.map(r => [r.reasonId, r.count])).toEqual([
      ['JUNK_IRRELEVANT', 90],
      ['JUNK_DUPLICATE', 80],
      ['JUNK_SERVICE', 50],
      ['JUNK_SPAM', 30]
    ])
    // Доли от брака с макета: 36 / 32 / 20 / 12 %.
    expect(report.junkByReason.map(r => Math.round(r.shareOfJunk * 100))).toEqual([36, 32, 20, 12])
  })

  it('проигранные сделки и их причины совпадают с макетом', () => {
    expect(report.lostDeals).toMatchObject({ count: 380, lostRevenue: 300_000 })
    expect(report.lostDeals.shareOfQualified).toBe(0.38)
    expect(report.lostDeals.byReason.map(r => [r.reasonId, r.count, r.lostRevenue])).toEqual([
      ['LOSS_PRICE', 120, 95_000],
      ['LOSS_LEAD_TIME', 85, 68_000],
      ['LOSS_COMPETITOR', 70, 57_000],
      ['LOSS_NO_STOCK', 55, 44_000],
      ['LOSS_OTHER', 50, 36_000]
    ])
  })

  it('таблица источников совпадает с макетом', () => {
    expect(report.bySource.map(r => [r.sourceId, r.leads, r.junk, r.qualified, r.won])).toEqual([
      ['CALL', 500, 80, 420, 270],
      ['EMAIL', 300, 50, 250, 160],
      ['WEB_FORM', 250, 70, 180, 110],
      ['CHAT', 200, 50, 150, 80]
    ])
  })

  /**
   * ⚠ Ради этого тест и написан. На макете сумма выручки по источникам (490 000) не совпадает со
   * сводкой (485 000) — расхождение появилось потому, что итоги там набиты руками. Здесь итог
   * СЧИТАЕТСЯ, поэтому разойтись ему не из чего.
   */
  it('сумма выручки по источникам сходится со сводкой', () => {
    expect(report.bySource.reduce((sum, r) => sum + r.revenue, 0)).toBe(report.summary.revenue)
  })

  it('сумма лидов по источникам сходится со сводкой', () => {
    expect(report.bySource.reduce((sum, r) => sum + r.leads, 0)).toBe(report.summary.totalLeads)
  })

  it('на данных макета потерь до сделки нет — все качественные лиды дошли до сделки', () => {
    expect(report.preDealLoss.count).toBe(0)
  })

  /**
   * ⚠ Второе расхождение макета с ТЗ, и оно крупнее первого. По формуле ТЗ (делим на лиды без
   * брака) та же выборка даёт 100 % и 62 %, а на макете напечатано 80 % и 49,6 % — то есть макет
   * посчитан от ВСЕГО потока. Тест фиксирует обе величины, чтобы разница была измеримой, а не
   * предметом спора. Что выбрать — в docs/METRICS.md.
   */
  it('по формуле ТЗ те же данные дают другие конверсии', () => {
    const byTz = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads' })
    expect(byTz.summary.conversionBaseValue).toBe(1000)
    expect(byTz.summary.qualifiedShare).toBe(1)
    expect(byTz.summary.wonShare).toBe(0.62)
  })

  /**
   * Демо-данные должны выглядеть рабочим отделом, а не катастрофой: при нормативе в час
   * просроченной оказывалась половина лидов, и блок читался как поломка отчёта.
   */
  it('обработка лидов на демо-данных выглядит правдоподобно', () => {
    const withSla = buildReport(dataset.leads, dataset.deals, {
      conversionBase: 'all-leads',
      firstResponseSlaMinutes: 60,
      now: '2026-08-31T23:59:59Z'
    })
    expect(withSla.processing.processedShare).toBeGreaterThan(0.9)
    expect(withSla.processing.overdueShare!).toBeLessThan(0.25)
    expect(withSla.processing.avgFirstResponseMinutes!).toBeLessThan(60)
  })

  it('справочники покрывают все встреченные коды', () => {
    const usedSources = new Set(dataset.leads.map(l => l.sourceId))
    const usedJunk = new Set(dataset.leads.map(l => l.junkReasonId).filter(Boolean))
    const usedLoss = new Set(dataset.deals.map(d => d.lossReasonId).filter(Boolean))
    for (const id of usedSources) expect(dataset.dictionaries.sources[id]).toBeTruthy()
    for (const id of usedJunk) expect(dataset.dictionaries.junkReasons[id!]).toBeTruthy()
    for (const id of usedLoss) expect(dataset.dictionaries.lossReasons[id!]).toBeTruthy()
  })
})
