import type { ConversionBase, ReportDataset, ReportMetrics } from '~/types/report'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Источник данных отчёта.
 *
 * ⚠ Сейчас источник ОДИН — демонстрационный набор с согласованного макета. Живая выборка из
 * портала появится отдельным шагом: её нельзя написать вслепую,
 * потому что коды стадий, источников и причин в каждом портале свои, и проверять их надо на живом
 * портале, а не угадывать. Разделение сделано так, чтобы подмена источника не трогала ни ядро, ни
 * компоненты: меняется только то, что возвращает `dataset`. Перевод сырых ответов REST в типы
 * отчёта уже написан и проверен на живом портале — `app/utils/b24Adapter.ts`; здесь останется
 * только сходить за данными через `b24jssdk`.
 *
 * ⚠ Ходить надо КЛАССИЧЕСКИМИ `crm.lead.list` / `crm.deal.list`, а не `crm.item.list`: у
 * универсального метода для лидов `STATUS_ID` приезжает под именем `stageId`, а неизвестное поле
 * в `select` он принимает без ошибки и просто возвращает записи без него (`docs/PORTAL.md`).
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

  /**
   * Откуда взяты данные. Признак заведён СЕЙЧАС, хотя источник пока один: подключая живую
   * выборку, про `computed(() => true)` легко забыть, и отчёт продолжил бы уверять, что данные
   * демонстрационные (или наоборот). Здесь забыть нельзя — значение придётся выставить.
   */
  const source = ref<'mock' | 'portal'>('mock')

  const dataset = ref<ReportDataset>(buildMockDataset())
  const pending = ref(false)
  const error = ref<string | undefined>(undefined)

  /** Данные демонстрационные — интерфейс обязан сказать это вслух, а не подразумевать. */
  const isDemo = computed(() => source.value === 'mock')

  const report = computed<ReportMetrics>(() =>
    buildReport(dataset.value.leads, dataset.value.deals, {
      conversionBase: conversionBase.value,
      firstResponseSlaMinutes: firstResponseSlaMinutes.value,
      now: dataset.value.period.to + 'T23:59:59Z'
    })
  )

  return { dataset, report, conversionBase, firstResponseSlaMinutes, pending, error, source, isDemo }
}
