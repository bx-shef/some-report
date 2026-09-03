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
   * Знаменатель конверсий.
   *
   * ✅ `all-leads` — выбор ЗАКАЗЧИКА (ООО «Анкрон», 2026-09-03): конверсии считаются от всего
   * потока лидов, как на согласованном макете. Это отвечает на вопрос «как работает канал
   * привлечения целиком»: деньги на брак всё равно потрачены.
   *
   * ⚠ Раньше здесь стояла формула ТЗ (`quality-leads`, лиды без брака) — она давала 100 % и 62 %
   * там, где макет показывает 80 % и 49,6 %. Переключатель оставлен инструментом сравнения, но
   * умолчание теперь то, что выбрал заказчик. Подробности — `docs/METRICS.md`.
   */
  const conversionBase = ref<ConversionBase>('all-leads')

  /**
   * Норматив первого ответа, минуты. Пусто — просроченные не считаем.
   *
   * ✅ 120 минут — норматив ЗАКАЗЧИКА (2026-09-03).
   *
   * ⚠ Что именно считать «ответом» — любое дело по лиду или только исходящий звонок/письмо —
   * заказчик пока не сказал. До ответа блок честно сообщает, что данных о первом действии не
   * выбирали (`AdapterWarnings.firstResponseNotFetched`), а не показывает ноль обработанных.
   */
  const firstResponseSlaMinutes = ref<number | undefined>(120)

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
