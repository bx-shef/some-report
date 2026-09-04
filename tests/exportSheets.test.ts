import { describe, expect, it } from 'vitest'
import { exportFileName, filtersText, percent, reportSheets } from '~/utils/exportSheets'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Листы Excel собираются из тех же метрик, что и экран: число на листе обязано быть числом с
 * экрана, а не пересчётом. Здесь сторожим имена листов, заголовки и сходимость с отчётом.
 */
const dataset = buildMockDataset()
const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads', firstResponseSlaMinutes: 120 })

describe('reportSheets', () => {
  const sheets = reportSheets(report, dataset, {}, true)
  const byName = Object.fromEntries(sheets.map(s => [s.name, s.rows]))

  it('листы — по блокам экрана, имена короче 31 символа и без запрещённых знаков', () => {
    expect(sheets.map(s => s.name)).toEqual(['Сводка', 'Воронка', 'Брак по причинам', 'Причины проигрыша', 'Источники', 'Топ-5 источников', 'Обработка лидов'])
    for (const sheet of sheets) {
      expect(sheet.name.length).toBeLessThanOrEqual(31)
      expect(sheet.name).not.toMatch(/[[\]:*?/\\]/)
    }
  })

  it('сводка: период, фильтры, признак демо и числа отчёта', () => {
    const rows = byName['Сводка']!
    expect(rows[1]).toEqual(['Период', '01.08.2026 — 31.08.2026'])
    expect(rows[2]).toEqual(['Фильтры', 'нет'])
    expect(rows[3]![1]).toContain('демонстрационный')
    expect(rows).toContainEqual(['Лиды', report.summary.totalLeads, 100])
    expect(rows).toContainEqual(['Брак лидов', report.summary.junk, percent(report.summary.junkShare)])
    expect(rows).toContainEqual(['Успешные сделки из лидов', report.summary.wonDeals, percent(report.summary.wonShare)])
    expect(rows).toContainEqual([`Выручка по лидам, ${dataset.currencyId}`, report.summary.revenue, ''])
  })

  it('таблицы: заголовок, строки по числу строк отчёта, итог сходится', () => {
    const junk = byName['Брак по причинам']!
    expect(junk[0]).toEqual(['Причина брака', 'Лидов', '% от лидов', '% от брака'])
    expect(junk).toHaveLength(report.junkByReason.length + 2)
    expect(junk.at(-1)).toEqual(['Итого', report.summary.junk, percent(report.summary.junkShare), 100])
    const junkSum = junk.slice(1, -1).reduce((acc, row) => acc + Number(row[1]), 0)
    expect(junkSum).toBe(report.summary.junk)

    const lost = byName['Причины проигрыша']!
    expect(lost).toHaveLength(report.lostDeals.byReason.length + 2)
    expect(lost.at(-1)).toEqual(['Итого', report.lostDeals.count, 100, report.lostDeals.lostRevenue, 100])

    const sources = byName['Источники']!
    expect(sources).toHaveLength(report.bySource.length + 1)
    expect(sources[1]!.slice(1)).toEqual([report.bySource[0]!.leads, report.bySource[0]!.junk, percent(report.bySource[0]!.junkShare), report.bySource[0]!.qualified, percent(report.bySource[0]!.crToDeal), report.bySource[0]!.won, percent(report.bySource[0]!.crToSale), report.bySource[0]!.revenue])
    expect(byName['Топ-5 источников']).toHaveLength(report.topSources.length + 1)
    // Каждая строка таблицы — той же ширины, что заголовок: Excel не должен показывать рваные колонки.
    for (const rows of [junk, lost, sources]) for (const row of rows) expect(row).toHaveLength(rows[0]!.length)
  })

  it('обработка: числа блока 6 и потери до сделки; без истории — прочерки, а не нули', () => {
    const rows = byName['Обработка лидов']!
    expect(rows).toContainEqual(['Обработано', report.processing!.processed, percent(report.processing!.processedShare)])
    expect(rows).toContainEqual(['Не дошли до сделки', report.preDealLoss.count, percent(report.preDealLoss.share)])
    const noTime = reportSheets({ ...report, processing: { ...report.processing!, overdue: undefined, overdueShare: undefined, avgFirstResponseMinutes: undefined } }, dataset, {}, true)
    const processing = noTime.find(s => s.name === 'Обработка лидов')!.rows
    expect(processing).toContainEqual(['Просрочено', '—', '—'])
    expect(processing).toContainEqual(['Среднее время первого ответа, мин', '—', ''])
  })

  it('сделки без лида — отдельный лист только когда справка пришла', () => {
    const withUnlinked = reportSheets(report, { ...dataset, unlinkedDeals: { total: 5, revenue: 1000, unconverted: 0, totalShareOfRevenue: 1, rows: [{ sourceId: 'CALL', count: 5, share: 1, revenue: 1000, shareOfRevenue: 1 }] } }, {}, false)
    const sheet = withUnlinked.find(s => s.name === 'Сделки без лида')!
    expect(sheet.rows[1]).toEqual(['Всего', 5, '', 1000, ''])
    expect(sheet.rows.at(-1)![0]).toBe('Входящий звонок')
    expect(sheet.rows.at(-1)!.slice(1)).toEqual([5, 100, 1000, 100])
  })
})

describe('подписи', () => {
  it('фильтры словами из справочников; причина закрытия важнее стадии; менеджер без имени — номером', () => {
    const [sourceId] = Object.keys(dataset.dictionaries.sources)
    const [junkId] = Object.keys(dataset.dictionaries.junkReasons)
    const text = filtersText({ sourceId, assignedById: 2, leadStatusId: 'NEW', junkReasonId: junkId, lossReasonKey: 'LOSS_PRICE' }, dataset.dictionaries)
    expect(text).toContain(`источник: ${dataset.dictionaries.sources[sourceId!]}`)
    expect(text).toContain('менеджер: Петров Сергей')
    expect(text).toContain(`причина закрытия лида: ${dataset.dictionaries.junkReasons[junkId!]}`)
    expect(text).not.toContain('стадия лида')
    expect(text).toContain(`причина проигрыша: ${dataset.dictionaries.lossReasons.LOSS_PRICE}`)
    expect(filtersText({ assignedById: 77 }, { ...dataset.dictionaries, users: {} })).toBe('менеджер: #77')
  })

  it('проценты с одним знаком, имя файла с периодом', () => {
    expect(percent(0.20456)).toBe(20.5)
    expect(percent(1)).toBe(100)
    expect(exportFileName({ from: '2026-08-01', to: '2026-08-31' }, 'xlsx')).toBe('analitika-po-lidam_2026-08-01_2026-08-31.xlsx')
  })
})
