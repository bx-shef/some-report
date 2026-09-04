import type { ReportDataset, ReportFilters, ReportMetrics, ReportPeriod } from '~/types/report'
import { formatDate } from '~/utils/format'
import { junkReasonLabel, leadStageLabel, lossReasonLabel, sourceLabel, unlinkedSourceLabel } from '~/utils/labels'

/**
 * Экспорт в Excel: таблицы отчёта как листы книги (решение владельца от 2026-09-04, п. 11:
 * «Excel — из таблиц»). Здесь — ЧТО в листах: имена, заголовки, строки. Чистые функции без
 * зависимости от библиотеки записи файла: числа на листах обязаны совпадать с экраном, и это
 * проверяется тестом на тех же метриках; сама запись `.xlsx` — в `useExport`.
 *
 * ⚠ Доли — процентами с одним знаком (`20,5`), а не дробями `0.205`: файл открывает человек в
 * Excel, и «0,205» в колонке «%» читается как ошибка. Деньги — числами без валюты, валюта в
 * заголовке колонки: иначе сумму по колонке не посчитать.
 */

export type Cell = string | number

export interface Sheet {
  /** Имя листа: Excel режет длиннее 31 символа и не терпит `[]:*?/\\` — имена здесь короткие. */
  name: string
  rows: Cell[][]
}

/** Доля → проценты с одним знаком: `0.20456` → `20.5`. */
export function percent(share: number): number {
  return Math.round(share * 1000) / 10
}

/** Минуты → число с одним знаком; нет времени — прочерк. */
function minutes(value: number | undefined): Cell {
  return value === undefined ? '—' : Math.round(value * 10) / 10
}

/** Активные фильтры словами — в шапку файла: числа без условий, под которыми посчитаны, врут. */
export function filtersText(filters: ReportFilters, dictionaries: ReportDataset['dictionaries']): string {
  const parts: string[] = []
  if (filters.sourceId) parts.push(`источник: ${sourceLabel(dictionaries, filters.sourceId)}`)
  if (filters.assignedById) parts.push(`менеджер: ${dictionaries.users?.[String(filters.assignedById)] ?? `#${filters.assignedById}`}`)
  if (filters.junkReasonId) parts.push(`причина закрытия лида: ${junkReasonLabel(dictionaries, filters.junkReasonId)}`)
  else if (filters.leadStatusId) parts.push(`стадия лида: ${leadStageLabel(dictionaries, filters.leadStatusId)}`)
  if (filters.lossReasonKey) parts.push(`причина проигрыша: ${lossReasonLabel(dictionaries, filters.lossReasonKey)}`)
  return parts.length ? parts.join('; ') : 'нет'
}

/** Имя файла: латиницей, с периодом — чтобы два выгруженных отчёта не перепутались в «Загрузках». */
export function exportFileName(period: ReportPeriod, extension: 'xlsx' | 'pdf'): string {
  return `analitika-po-lidam_${period.from}_${period.to}.${extension}`
}

/** Листы книги по метрикам отчёта. Порядок — как блоки на экране. */
export function reportSheets(report: ReportMetrics, dataset: ReportDataset, filters: ReportFilters, isDemo: boolean): Sheet[] {
  const { dictionaries, currencyId, period } = dataset
  const money = `Сумма, ${currencyId}`
  const { summary } = report

  const sheets: Sheet[] = []

  sheets.push({
    name: 'Сводка',
    rows: [
      ['Аналитика по лидам', ''],
      ['Период', `${formatDate(period.from)} — ${formatDate(period.to)}`],
      ['Фильтры', filtersText(filters, dictionaries)],
      ['Данные', isDemo ? 'демонстрационный набор, не данные портала' : 'портал Битрикс24'],
      [],
      ['Показатель', 'Значение', '%'],
      ['Лиды', summary.totalLeads, 100],
      ['Брак лидов', summary.junk, percent(summary.junkShare)],
      ['Квалифицировано в сделку', summary.qualified, percent(summary.qualifiedShare)],
      ['Успешные сделки из лидов', summary.wonDeals, percent(summary.wonShare)],
      [`Выручка по лидам, ${currencyId}`, summary.revenue, ''],
      ['Знаменатель конверсий', summary.conversionBaseValue, summary.conversionBase === 'quality-leads' ? 'лиды без брака' : 'все лиды'],
      ...(summary.allDeals ? [['Успешных сделок всего в портале за период', summary.allDeals.won, '']] as Cell[][] : [])
    ]
  })

  sheets.push({
    name: 'Воронка',
    rows: [
      ['Ступень', 'Количество', '%'],
      ...report.funnel.map((stage): Cell[] => [stage.label, stage.count, percent(stage.share)])
    ]
  })

  sheets.push({
    name: 'Брак по причинам',
    rows: [
      ['Причина брака', 'Лидов', '% от лидов', '% от брака'],
      ...report.junkByReason.map((row): Cell[] => [junkReasonLabel(dictionaries, row.reasonId), row.count, percent(row.shareOfLeads), percent(row.shareOfJunk)]),
      ['Итого', summary.junk, percent(summary.junkShare), 100]
    ]
  })

  sheets.push({
    name: 'Причины проигрыша',
    rows: [
      ['Причина проигрыша', 'Сделок', '% от проигранных', money, '% от суммы'],
      ...report.lostDeals.byReason.map((row): Cell[] => [lossReasonLabel(dictionaries, row.reasonId), row.count, percent(row.shareOfLost), row.lostRevenue, percent(row.shareOfLostRevenue)]),
      ['Итого', report.lostDeals.count, 100, report.lostDeals.lostRevenue, 100]
    ]
  })

  const sourceHeader: Cell[] = ['Источник', 'Лиды', 'Брак', '% брака', 'Квалифицировано', 'CR лид → сделка, %', 'Успешные сделки', 'CR лид → продажа, %', `Выручка, ${currencyId}`]
  const sourceRow = (row: ReportMetrics['bySource'][number]): Cell[] => [
    sourceLabel(dictionaries, row.sourceId), row.leads, row.junk, percent(row.junkShare), row.qualified, percent(row.crToDeal), row.won, percent(row.crToSale), row.revenue
  ]
  sheets.push({ name: 'Источники', rows: [sourceHeader, ...report.bySource.map(sourceRow)] })
  sheets.push({ name: 'Топ-5 источников', rows: [sourceHeader, ...report.topSources.map(sourceRow)] })

  const processing = report.processing
  const processingRows: Cell[][] = processing
    ? [
        ['Показатель', 'Значение', '%'],
        ['Обработано', processing.processed, percent(processing.processedShare)],
        ['Не обработано', processing.unprocessed, percent(processing.unprocessedShare)],
        ['Просрочено', processing.overdue ?? '—', processing.overdueShare === undefined ? '—' : percent(processing.overdueShare)],
        ['Среднее время первого ответа, мин', minutes(processing.avgFirstResponseMinutes), ''],
        [],
        ['Источник', 'Обработано', 'Среднее время ответа, мин'],
        ...processing.bySource.map((row): Cell[] => [sourceLabel(dictionaries, row.sourceId), row.processed, minutes(row.avgFirstResponseMinutes)])
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
    processingRows.push([], ['Открытые лиды по стадии', 'Лидов', ''], ...loss.byStage.map((row): Cell[] => [leadStageLabel(dictionaries, row.stageId), row.count, '']))
  }
  sheets.push({ name: 'Обработка лидов', rows: processingRows })

  const unlinked = dataset.unlinkedDeals
  if (unlinked) {
    sheets.push({
      name: 'Сделки без лида',
      rows: [
        ['Успешные сделки без связи с лидом: период — по дате закрытия, фильтры отчёта не действуют', '', '', '', ''],
        ['Всего', unlinked.total, '', unlinked.revenue, ''],
        [],
        ['Источник сделки', 'Сделок', '%', money, '% суммы'],
        ...unlinked.rows.map((row): Cell[] => [unlinkedSourceLabel(dictionaries, row.sourceId), row.count, percent(row.share), row.revenue, percent(row.shareOfRevenue)])
      ]
    })
  }

  return sheets
}
