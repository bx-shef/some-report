import { describe, expect, it } from 'vitest'
import { exportFileName, filtersText, percent, reportSheets, safeText } from '~/utils/exportSheets'
import { formatPercent } from '~/utils/format'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Листы Excel собираются из тех же метрик, что и экран: число на листе обязано быть числом с
 * экрана, а не пересчётом. Здесь сторожим имена листов, заголовки, позиции колонок и то, что
 * каждое сырое число листа существует в отчёте.
 */
const dataset = buildMockDataset()
const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads', firstResponseSlaMinutes: 120 })

/** Все конечные числа объекта — множество «чисел отчёта». */
function numbersOf(value: unknown, into = new Set<number>()): Set<number> {
  if (typeof value === 'number' && Number.isFinite(value)) into.add(value)
  else if (Array.isArray(value)) value.forEach(item => numbersOf(item, into))
  else if (value && typeof value === 'object') Object.values(value).forEach(item => numbersOf(item, into))
  return into
}

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

  it('сводка: период, фильтры, признак демо, числа отчёта и от чего доля', () => {
    const rows = byName['Сводка']!
    expect(rows[1]).toEqual(['Период', '01.08.2026 — 31.08.2026', '', ''])
    expect(rows[2]).toEqual(['Фильтры', 'нет', '', ''])
    expect(rows[3]![1]).toContain('демонстрационный')
    expect(rows[5]).toEqual(['Показатель', 'Значение', '%', 'Доля от чего'])
    expect(rows).toContainEqual(['Лиды', report.summary.totalLeads, 100, 'все лиды'])
    expect(rows).toContainEqual(['Брак лидов', report.summary.junk, percent(report.summary.junkShare), 'все лиды'])
    expect(rows).toContainEqual(['Квалифицировано в сделку', report.summary.qualified, percent(report.summary.qualifiedShare), 'лиды без брака'])
    expect(rows).toContainEqual(['Успешные сделки из лидов', report.summary.wonDeals, percent(report.summary.wonShare), 'лиды без брака'])
    expect(rows).toContainEqual([`Выручка по лидам, ${dataset.currencyId}`, report.summary.revenue, '', ''])
    expect(rows).toContainEqual(['Знаменатель конверсий', report.summary.conversionBaseValue, '', 'лиды без брака'])
    // В демо-наборе все сделки — из лидов: пояснения про сделки без лида-родителя нет.
    expect(rows.some(row => String(row[0]).includes('без лида-родителя'))).toBe(false)
  })

  it('каждая таблица: заголовок, строки один в один с отчётом, итог сходится, строки одной ширины', () => {
    const funnel = byName['Воронка']!
    expect(funnel[0]).toEqual(['Ступень', 'Количество', '%', 'Доля от чего'])
    expect(funnel.slice(1)).toEqual(report.funnel.map((s, i) => [s.label, s.count, percent(s.share), i === 0 ? 'все лиды' : 'лиды без брака']))

    const junk = byName['Брак по причинам']!
    expect(junk[0]).toEqual(['Причина брака', 'Лидов', '% от лидов', '% от брака'])
    expect(junk.slice(1, -1).map(r => r[1])).toEqual(report.junkByReason.map(r => r.count))
    expect(junk.at(-1)).toEqual(['Итого', report.summary.junk, percent(report.summary.junkShare), 100])
    expect(junk.slice(1, -1).reduce((acc, row) => acc + Number(row[1]), 0)).toBe(report.summary.junk)

    const lost = byName['Причины проигрыша']!
    expect(lost.slice(1, -1)).toEqual(report.lostDeals.byReason.map(r => [dataset.dictionaries.lossReasons[r.reasonId], r.count, percent(r.shareOfLost), r.lostRevenue, percent(r.shareOfLostRevenue)]))
    expect(lost.at(-1)).toEqual(['Итого', report.lostDeals.count, 100, report.lostDeals.lostRevenue, 100])
    expect(lost.slice(1, -1).reduce((acc, row) => acc + Number(row[3]), 0)).toBe(report.lostDeals.lostRevenue)

    const sources = byName['Источники']!
    const sourceCells = (row: typeof report.bySource[number]) => [dataset.dictionaries.sources[row.sourceId], row.leads, row.junk, percent(row.junkShare), row.qualified, percent(row.crToDeal), row.won, percent(row.crToSale), row.revenue]
    expect(sources.slice(1, -1)).toEqual(report.bySource.map(sourceCells))
    const t = report.sourceTotals
    expect(sources.at(-1)).toEqual(['Итого', t.leads, t.junk, percent(t.junkShare), t.qualified, percent(t.crToDeal), t.won, percent(t.crToSale), t.revenue])
    expect(byName['Топ-5 источников']!.slice(1)).toEqual(report.topSources.map(sourceCells))

    const processing = byName['Обработка лидов']!
    expect(processing).toContainEqual(['Обработано', report.processing!.processed, percent(report.processing!.processedShare)])
    expect(processing).toContainEqual(['Не дошли до сделки', report.preDealLoss.count, percent(report.preDealLoss.share)])
    const bySourceStart = processing.findIndex(row => row[0] === 'Источник') + 1
    expect(processing.slice(bySourceStart, bySourceStart + report.processing!.bySource.length)).toEqual(
      report.processing!.bySource.map(r => [dataset.dictionaries.sources[r.sourceId], r.processed, Math.round(r.avgFirstResponseMinutes! * 10) / 10])
    )

    for (const rows of [funnel, junk, lost, sources, byName['Топ-5 источников']!]) for (const row of rows) expect(row).toHaveLength(rows[0]!.length)
  })

  // Сеть на фабрикацию: каждое сырое (не процентное) число листа — число из отчёта.
  it('каждое непроцентное число на листах есть в отчёте', () => {
    const known = numbersOf(report)
    known.add(100)
    const percentColumns: Record<string, number[]> = {
      'Сводка': [2], 'Воронка': [2], 'Брак по причинам': [2, 3], 'Причины проигрыша': [2, 4], 'Источники': [3, 5, 7], 'Топ-5 источников': [3, 5, 7], 'Обработка лидов': [2]
    }
    for (const sheet of sheets) {
      const skip = new Set(percentColumns[sheet.name] ?? [])
      for (const row of sheet.rows) {
        row.forEach((cell, index) => {
          if (typeof cell !== 'number' || skip.has(index)) return
          // Минуты по источникам — округлены; ищем округлённый оригинал.
          const ok = known.has(cell) || [...known].some(n => Math.round(n * 10) / 10 === cell)
          expect(ok, `${sheet.name}: ${cell}`).toBe(true)
        })
      }
    }
  })

  it('пустой период — без строк «Итого»: итог ничего — не итог', () => {
    const empty = reportSheets(buildReport([], [], { conversionBase: 'quality-leads' }), { ...dataset, leads: [], deals: [] }, {}, true)
    const by = Object.fromEntries(empty.map(s => [s.name, s.rows]))
    expect(by['Брак по причинам']).toHaveLength(1)
    expect(by['Причины проигрыша']).toHaveLength(1)
    expect(by['Источники']).toHaveLength(1)
  })

  it('обработка: без истории — прочерки; пока считается — «считается»; сделки без лида — пометка в сводке', () => {
    const noTime = { ...report, processing: { ...report.processing!, overdue: undefined, overdueShare: undefined, avgFirstResponseMinutes: undefined } }
    const idle = Object.fromEntries(reportSheets(noTime, dataset, {}, true).map(s => [s.name, s.rows]))
    expect(idle['Обработка лидов']).toContainEqual(['Просрочено', '—', '—'])
    expect(idle['Обработка лидов']).toContainEqual(['Среднее время первого ответа, мин', '—', ''])
    const busy = Object.fromEntries(reportSheets(noTime, dataset, {}, false, { processingPending: true, unlinkedPending: true }).map(s => [s.name, s.rows]))
    expect(busy['Обработка лидов']).toContainEqual(['Просрочено', 'считается', 'считается'])
    expect(busy['Сводка']!.some(row => String(row[1]).includes('ещё считаются'))).toBe(true)
    expect(busy['Сводка']!.some(row => row[0] === 'Сделки без лида')).toBe(true)
  })

  it('сделки вне разреза источников — пояснение в сводке и под таблицей источников', () => {
    const outside = { ...report, outsideSources: { deals: 3, revenue: 900 } }
    const by = Object.fromEntries(reportSheets(outside, dataset, {}, false).map(s => [s.name, s.rows]))
    expect(by['Сводка']).toContainEqual(['Успешных сделок без лида-родителя', 3, '', 'в сводке учтены, в разрезе источников — нет: источник неизвестен'])
    expect(by['Сводка']).toContainEqual([`их выручка, ${dataset.currencyId}`, 900, '', ''])
    const note = by['Источники']!.at(-1)!
    expect(String(note[0])).toContain('без лида-родителя: 3')
    expect(note).toHaveLength(by['Источники']![0]!.length)
  })

  it('сделки без лида — отдельный лист только когда справка пришла; валюта без курса — оговорка', () => {
    const unlinked = { total: 5, revenue: 1000, unconverted: 2, totalShareOfRevenue: 1, rows: [{ sourceId: 'CALL', count: 5, share: 1, revenue: 1000, shareOfRevenue: 1 }] }
    const sheet = reportSheets(report, { ...dataset, unlinkedDeals: unlinked }, {}, false).find(s => s.name === 'Сделки без лида')!
    expect(sheet.rows[1]).toEqual(['Всего', 5, '', 1000, ''])
    expect(sheet.rows[2]).toEqual(['Сделок в валюте без курса — суммы взяты как есть', 2, '', '', ''])
    expect(sheet.rows.at(-1)).toEqual(['Входящий звонок', 5, 100, 1000, 100])
    for (const row of sheet.rows) if (row.length) expect(row).toHaveLength(5)
  })
})

describe('подписи и числа', () => {
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

  // Экран и лист округляют одной функцией: на 0,2875 `toFixed` и `Math.round` расходятся.
  it('проценты — как на экране, на всех долях с знаменателем до 400', () => {
    for (let d = 1; d <= 400; d++) {
      for (let n = 0; n <= d; n += Math.max(1, Math.floor(d / 7))) {
        const share = n / d
        expect(percent(share), `${n}/${d}`).toBe(Number(formatPercent(share).replace(/\s|%/g, '').replace(',', '.')))
      }
    }
    expect(percent(0.2875)).toBe(Number(formatPercent(0.2875).replace(/\s|%/g, '').replace(',', '.')))
  })

  it('текст из портала с ведущим знаком формулы получает пробел; имя файла с периодом', () => {
    expect(safeText('=SUM(A1)')).toBe(' =SUM(A1)')
    expect(safeText('+7 900')).toBe(' +7 900')
    expect(safeText('-скидка')).toBe(' -скидка')
    expect(safeText('@user')).toBe(' @user')
    expect(safeText('Звонок')).toBe('Звонок')
    const named = reportSheets(report, { ...dataset, dictionaries: { ...dataset.dictionaries, sources: { ...dataset.dictionaries.sources, [Object.keys(dataset.dictionaries.sources)[0]!]: '=HYPERLINK()' } } }, {}, true)
    expect(named.find(s => s.name === 'Источники')!.rows.some(r => r[0] === ' =HYPERLINK()')).toBe(true)
    expect(exportFileName({ from: '2026-08-01', to: '2026-08-31' }, 'xlsx')).toBe('analitika-po-lidam_2026-08-01_2026-08-31.xlsx')
  })
})
