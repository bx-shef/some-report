import type { ReportDataset, ReportFilters, ReportMetrics, ReportPeriod } from '~/types/report'
import { formatCount, formatDate, formatMoney, roundPercent } from '~/utils/format'
import { junkReasonLabel, leadStageLabel, lossReasonLabel, sourceLabel, unlinkedSourceLabel } from '~/utils/labels'

/**
 * Экспорт в Excel: таблицы отчёта как листы книги (решение владельца от 2026-09-04, п. 11:
 * «Excel — из таблиц»). Здесь — ЧТО в листах: имена, заголовки, строки. Чистые функции без
 * зависимости от библиотеки записи файла: числа на листах обязаны совпадать с экраном, и это
 * проверяется тестом на тех же метриках; сама запись `.xlsx` — в `useExport`.
 *
 * ⚠ Ни одной формулы: только готовые поля `ReportMetrics` (issue #3). Доли — процентами с одним
 * знаком тем же округлением, что на экране (`roundPercent`), а не дробями `0.205`: файл открывает
 * человек, и «0,205» в колонке «%» читается как ошибка. Деньги — числами без валюты, валюта в
 * заголовке колонки: иначе сумму по колонке не посчитать. Время — минутами, не «1 ч 35 мин».
 */

export type Cell = string | number

export interface Sheet {
  /** Имя листа: Excel режет длиннее 31 символа и не терпит `[]:*?/\\` — имена здесь короткие. */
  name: string
  rows: Cell[][]
}

/** Что ещё считается в фоне на момент выгрузки — файл обязан сказать, чего в нём пока нет. */
export interface ExportState {
  /** История стадий (время ответа, просрочка) ещё идёт. */
  processingPending?: boolean
  /** Справка блока 7 ещё идёт — листа «Сделки без лида» не будет. */
  unlinkedPending?: boolean
}

/** Доля → проценты с одним знаком, как `formatPercent` на экране. */
export function percent(share: number): number {
  return roundPercent(share, 1)
}

/** Минуты → число с одним знаком; нет времени — прочерк или «считается». */
function minutes(value: number | undefined, pending: boolean): Cell {
  if (value !== undefined) return Math.round(value * 10) / 10
  return pending ? 'считается' : '—'
}

/**
 * Текст из портала в ячейку. Ведущие `=`, `+`, `-`, `@` табличные редакторы могут прочитать как
 * формулу (formula injection). В `.xlsx` строка типизирована строкой и формулой не станет, но
 * названия стадий и имена сотрудников правят люди — защита в глубину стоит одного пробела.
 */
export function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? ` ${value}` : value
}

/** Активные фильтры словами — в шапку файла: числа без условий, под которыми посчитаны, врут. */
export function filtersText(filters: ReportFilters, dictionaries: ReportDataset['dictionaries']): string {
  const parts: string[] = []
  if (filters.sourceId) parts.push(`источник: ${sourceLabel(dictionaries, filters.sourceId)}`)
  if (filters.assignedById) parts.push(`менеджер: ${dictionaries.users?.[String(filters.assignedById)] ?? `#${filters.assignedById}`}`)
  if (filters.junkReasonId) parts.push(`причина закрытия лида: ${junkReasonLabel(dictionaries, filters.junkReasonId)}`)
  else if (filters.leadStatusId) parts.push(`стадия лида: ${leadStageLabel(dictionaries, filters.leadStatusId)}`)
  if (filters.lossReasonKey) parts.push(`причина проигрыша: ${lossReasonLabel(dictionaries, filters.lossReasonKey)}`)
  return parts.length ? safeText(parts.join('; ')) : 'нет'
}

/** Имя файла: латиницей, с периодом — чтобы два выгруженных отчёта не перепутались в «Загрузках». */
export function exportFileName(period: ReportPeriod, extension: 'xlsx' | 'pdf'): string {
  return `analitika-po-lidam_${period.from}_${period.to}.${extension}`
}

/** Строка во всю ширину таблицы: текст в первой ячейке, остальные пустые — Excel не любит рваные строки. */
function wide(text: string, width: number): Cell[] {
  return [text, ...Array.from({ length: width - 1 }, () => '')]
}

/** Листы книги по метрикам отчёта. Порядок — как блоки на экране. */
export function reportSheets(report: ReportMetrics, dataset: ReportDataset, filters: ReportFilters, isDemo: boolean, state: ExportState = {}): Sheet[] {
  const { dictionaries, currencyId, period } = dataset
  const money = `Сумма, ${currencyId}`
  const { summary, sourceTotals: totals, outsideSources } = report
  const base = summary.conversionBase === 'quality-leads' ? 'лиды без брака' : 'все лиды'
  const label = {
    source: (id: string) => safeText(sourceLabel(dictionaries, id)),
    junk: (id: string) => safeText(junkReasonLabel(dictionaries, id)),
    loss: (id: string) => safeText(lossReasonLabel(dictionaries, id)),
    stage: (id: string) => safeText(leadStageLabel(dictionaries, id)),
    unlinkedSource: (id: string) => safeText(unlinkedSourceLabel(dictionaries, id))
  }

  const sheets: Sheet[] = []

  // ⚠ Колонка «%» в сводке — от РАЗНЫХ знаменателей: брак — от всех лидов, конверсии — от базы.
  // Без колонки «доля от чего» «Квалифицировано 1 000 | 100» под «Лиды 1 250» читалось бы как
  // ошибка — ровно тот спор, из-за которого переписывали формулы (docs/METRICS.md).
  const summaryRows: Cell[][] = [
    ['Аналитика по лидам', '', '', ''],
    ['Период', `${formatDate(period.from)} — ${formatDate(period.to)}`, '', ''],
    ['Фильтры', filtersText(filters, dictionaries), '', ''],
    ['Данные', isDemo ? 'демонстрационный набор, не данные портала' : 'портал Битрикс24', '', ''],
    [],
    ['Показатель', 'Значение', '%', 'Доля от чего'],
    ['Лиды', summary.totalLeads, 100, 'все лиды'],
    ['Брак лидов', summary.junk, percent(summary.junkShare), 'все лиды'],
    ['Квалифицировано в сделку', summary.qualified, percent(summary.qualifiedShare), base],
    ['Успешные сделки из лидов', summary.wonDeals, percent(summary.wonShare), base],
    [`Выручка по лидам, ${currencyId}`, summary.revenue, '', ''],
    ['Знаменатель конверсий', summary.conversionBaseValue, '', base]
  ]
  if (summary.allDeals) summaryRows.push(['Успешных сделок всего в портале за период', summary.allDeals.won, '', 'по дате создания, включая сделки без лида'])
  // То же пояснение, что под таблицей источников на экране: без него сумма по колонке «Выручка»
  // листа «Источники» меньше выручки сводки, и в файле этому негде объясниться (issue #3).
  if (outsideSources.deals > 0 || outsideSources.revenue > 0) {
    summaryRows.push(
      ['Успешных сделок без лида-родителя', outsideSources.deals, '', 'в сводке учтены, в разрезе источников — нет: источник неизвестен'],
      [`их выручка, ${currencyId}`, outsideSources.revenue, '', '']
    )
  }
  if (state.processingPending) summaryRows.push(['Обработка лидов', 'время ответа и просрочка ещё считаются — выгрузите позже', '', ''])
  if (state.unlinkedPending) summaryRows.push(['Сделки без лида', 'ещё считаются — лист появится в следующей выгрузке', '', ''])
  sheets.push({ name: 'Сводка', rows: summaryRows })

  sheets.push({
    name: 'Воронка',
    rows: [
      ['Ступень', 'Количество', '%', 'Доля от чего'],
      ...report.funnel.map((stage, index): Cell[] => [stage.label, stage.count, percent(stage.share), index === 0 ? 'все лиды' : base])
    ]
  })

  const junkRows: Cell[][] = [
    ['Причина брака', 'Лидов', '% от лидов', '% от брака'],
    ...report.junkByReason.map((row): Cell[] => [label.junk(row.reasonId), row.count, percent(row.shareOfLeads), percent(row.shareOfJunk)])
  ]
  // Итог — только когда есть строки: «Итого 0 | 0 | 100 %» на пустом периоде — итог ничего.
  if (report.junkByReason.length) junkRows.push(['Итого', summary.junk, percent(summary.junkShare), 100])
  sheets.push({ name: 'Брак по причинам', rows: junkRows })

  const lostRows: Cell[][] = [
    ['Причина проигрыша', 'Сделок', '% от проигранных', money, '% от суммы'],
    ...report.lostDeals.byReason.map((row): Cell[] => [label.loss(row.reasonId), row.count, percent(row.shareOfLost), row.lostRevenue, percent(row.shareOfLostRevenue)])
  ]
  if (report.lostDeals.byReason.length) lostRows.push(['Итого', report.lostDeals.count, 100, report.lostDeals.lostRevenue, 100])
  sheets.push({ name: 'Причины проигрыша', rows: lostRows })

  const sourceHeader: Cell[] = ['Источник', 'Лиды', 'Брак', '% брака', 'Квалифицировано', 'CR лид → сделка, %', 'Успешные сделки', 'CR лид → продажа, %', `Выручка, ${currencyId}`]
  const sourceRow = (row: ReportMetrics['bySource'][number]): Cell[] => [
    label.source(row.sourceId), row.leads, row.junk, percent(row.junkShare), row.qualified, percent(row.crToDeal), row.won, percent(row.crToSale), row.revenue
  ]
  const sourcesRows: Cell[][] = [sourceHeader, ...report.bySource.map(sourceRow)]
  if (report.bySource.length) {
    sourcesRows.push(['Итого', totals.leads, totals.junk, percent(totals.junkShare), totals.qualified, percent(totals.crToDeal), totals.won, percent(totals.crToSale), totals.revenue])
  }
  if (outsideSources.deals > 0 || outsideSources.revenue > 0) {
    sourcesRows.push(wide(`Успешных сделок без лида-родителя: ${formatCount(outsideSources.deals)} на ${formatMoney(outsideSources.revenue, currencyId)} — их источник неизвестен, в эту таблицу они не входят, в сводке учтены`, sourceHeader.length))
  }
  sheets.push({ name: 'Источники', rows: sourcesRows })
  sheets.push({ name: 'Топ-5 источников', rows: [sourceHeader, ...report.topSources.map(sourceRow)] })

  const processing = report.processing
  const pending = Boolean(state.processingPending)
  const processingRows: Cell[][] = processing
    ? [
        ['Показатель', 'Значение', '%'],
        ['Обработано', processing.processed, percent(processing.processedShare)],
        ['Не обработано', processing.unprocessed, percent(processing.unprocessedShare)],
        ['Просрочено', processing.overdue ?? (pending ? 'считается' : '—'), processing.overdueShare === undefined ? (pending ? 'считается' : '—') : percent(processing.overdueShare)],
        ['Среднее время первого ответа, мин', minutes(processing.avgFirstResponseMinutes, pending), ''],
        [],
        ['Источник', 'Обработано', 'Среднее время ответа, мин'],
        ...processing.bySource.map((row): Cell[] => [label.source(row.sourceId), row.processed, minutes(row.avgFirstResponseMinutes, pending)])
      ]
    : [['Обработка лидов не посчитана', '', '']]
  const loss = report.preDealLoss
  processingRows.push(
    [],
    ['Потери до сделки', 'Лидов', '%'],
    ['Не дошли до сделки', loss.count, percent(loss.share)],
    ['из них ещё в работе', loss.stillInWork, ''],
    ['закрыты без сделки', loss.closedWithoutDeal, '']
  )
  if (loss.byStage?.length) {
    processingRows.push([], ['Открытые лиды по стадии', 'Лидов', ''], ...loss.byStage.map((row): Cell[] => [label.stage(row.stageId), row.count, '']))
  }
  sheets.push({ name: 'Обработка лидов', rows: processingRows })

  const unlinked = dataset.unlinkedDeals
  if (unlinked) {
    const rows: Cell[][] = [
      wide('Успешные сделки без связи с лидом: период — по дате закрытия, фильтры отчёта не действуют', 5),
      ['Всего', unlinked.total, '', unlinked.revenue, '']
    ]
    if (unlinked.unconverted > 0) rows.push(['Сделок в валюте без курса — суммы взяты как есть', unlinked.unconverted, '', '', ''])
    rows.push(
      [],
      ['Источник сделки', 'Сделок', '%', money, '% суммы'],
      ...unlinked.rows.map((row): Cell[] => [label.unlinkedSource(row.sourceId), row.count, percent(row.share), row.revenue, percent(row.shareOfRevenue)])
    )
    sheets.push({ name: 'Сделки без лида', rows })
  }

  return sheets
}
