import type { ConversionBase, ReportDataset, ReportMetrics } from '~/types/report'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Источник данных отчёта.
 *
 * ⚠ Сейчас источник ОДИН — демонстрационный набор с согласованного макета. Живая выборка из
 * портала (`crm.item.list` + справочники) появится отдельным шагом: её нельзя написать вслепую,
 * потому что коды стадий, источников и причин в каждом портале свои, и проверять их надо на живом
 * портале, а не угадывать. Разделение сделано так, чтобы подмена источника не трогала ни ядро, ни
 * компоненты: меняется только то, что возвращает `dataset`.
 */
export function useReportData() {
  /**
   * Знаменатель конверсий — переключатель, а не спрятанное решение. Ровно из-за него отчёт и
   * читается по-разному (см. `docs/METRICS.md`), поэтому база видна человеку и меняется на месте.
   * По умолчанию — формула ТЗ.
   */
  const conversionBase = ref<ConversionBase>('quality-leads')

  /** Норматив первого ответа, минуты. Пусто — просроченные не считаем. */
  const firstResponseSlaMinutes = ref<number | undefined>(60)

  const dataset = ref<ReportDataset>(buildMockDataset())
  const pending = ref(false)
  const error = ref<string | undefined>(undefined)

  /** Данные демонстрационные — интерфейс обязан сказать это вслух, а не подразумевать. */
  const isDemo = computed(() => true)

  const report = computed<ReportMetrics>(() =>
    buildReport(dataset.value.leads, dataset.value.deals, {
      conversionBase: conversionBase.value,
      firstResponseSlaMinutes: firstResponseSlaMinutes.value,
      now: dataset.value.period.to + 'T23:59:59Z'
    })
  )

  return { dataset, report, conversionBase, firstResponseSlaMinutes, pending, error, isDemo }
}
