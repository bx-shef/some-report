import type { ConversionBase, ReportDataset, ReportMetrics, ReportPeriod } from '~/types/report'
import type { AdapterWarnings, B24CurrencyRow, B24DealRow, B24LeadRow, B24StatusRow } from '~/utils/b24Adapter'
import { adaptPortalData } from '~/utils/b24Adapter'
import { currentMonthPeriod, dealListParams, dictionaryBatch, latestLeadParams, leadListParams } from '~/utils/b24Query'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Источник данных отчёта — единственное место, которое знает, ОТКУДА берутся лиды и сделки.
 *
 * Слоями это устроено так: `b24Query.ts` говорит, что спросить у портала, `b24Adapter.ts` —
 * как перевести ответы в типы отчёта, `metrics.ts` — как их посчитать. Здесь только склейка и
 * состояния загрузки; ни одной формулы и ни одного знания про формат REST.
 *
 * ⚠ Вне портала (открыли по прямой ссылке, `?preview=1`) остаётся демонстрационный набор — брать
 * данные неоткуда. Признак `isDemo` обязан это показывать: отчёт, молча выдающий чужие числа за
 * данные клиента, хуже отсутствующего отчёта.
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
  /** Оговорки адаптера к качеству данных портала. Пока источник демонстрационный — их нет. */
  const warnings = ref<AdapterWarnings | undefined>(undefined)
  /**
   * Дата последнего лида в портале — спрашивается ТОЛЬКО когда за период не нашлось ни одного.
   *
   * ⚠ Без неё пустой отчёт неотличим от сломанного. С ней экран говорит «в этом периоде лидов
   * нет, последний был 17.08» — то есть называет причину и следующее действие.
   */
  const latestLeadDate = ref<string | undefined>(undefined)

  /** Данные демонстрационные — интерфейс обязан сказать это вслух, а не подразумевать. */
  const isDemo = computed(() => source.value === 'mock')

  const report = computed<ReportMetrics>(() =>
    buildReport(dataset.value.leads, dataset.value.deals, {
      conversionBase: conversionBase.value,
      firstResponseSlaMinutes: firstResponseSlaMinutes.value,
      now: dataset.value.period.to + 'T23:59:59Z'
    })
  )

  const b24 = useB24()

  /**
   * Выборка всех страниц списочного метода.
   *
   * ⚠ Именно `callList`, а не `call` со `start`: у заказчика до 5 000 лидов и сделок в месяц
   * (замер 2026-09-03), то есть до сотни страниц по 50 записей. `callList` идёт курсором по `ID`
   * и не заказывает подсчёт общего числа записей — на таких объёмах это разница между секундами
   * и десятками секунд.
   */
  async function fetchAll<T>(method: string, params: object): Promise<T[]> {
    const result = await b24.getOrThrow().actions.v2.callList.make<T>({ method, params })
    if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
    return (result.getData() ?? []) as T[]
  }

  /** Дата создания самого свежего лида портала, если он есть. Ошибку глушим: это подсказка. */
  async function fetchLatestLeadDate(): Promise<string | undefined> {
    try {
      const result = await b24.getOrThrow().actions.v2.call.make<B24LeadRow[]>({
        method: 'crm.lead.list',
        params: latestLeadParams()
      })
      const rows = result.getData()
      const date = Array.isArray(rows) ? rows[0]?.DATE_CREATE : undefined
      return typeof date === 'string' && date ? date.slice(0, 10) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Забрать данные портала за период и пересчитать отчёт.
   *
   * Вне фрейма — тихо остаёмся на демонстрационном наборе: это штатный режим страницы,
   * открытой по прямой ссылке, а не ошибка.
   */
  async function load(period: ReportPeriod = currentMonthPeriod(new Date())): Promise<void> {
    await b24.init()
    if (!b24.isInit()) return

    pending.value = true
    error.value = undefined
    try {
      // Справочники — одним пакетом: их четыре и они маленькие, отдельными запросами это
      // четыре круга по сети вместо одного.
      const dictionaries = await b24.getOrThrow().actions.v2.batch.make<unknown>({
        calls: dictionaryBatch()
      })
      if (!dictionaries.isSuccess) throw new Error(dictionaries.getErrorMessages().join('; '))
      const books = (dictionaries.getData() ?? {}) as Record<string, unknown>
      const rows = <T>(key: string): T[] => (Array.isArray(books[key]) ? books[key] as T[] : [])

      latestLeadDate.value = undefined
      const [leads, deals] = await Promise.all([
        fetchAll<B24LeadRow>('crm.lead.list', leadListParams(period)),
        fetchAll<B24DealRow>('crm.deal.list', dealListParams(period))
      ])

      const adapted = adaptPortalData({
        leads,
        deals,
        currencies: rows<B24CurrencyRow>('currencies'),
        sources: rows<B24StatusRow>('sources'),
        leadStatuses: rows<B24StatusRow>('leadStatuses'),
        dealStages: rows<B24StatusRow>('dealStages')
        // ⚠ `firstResponse` не передаём намеренно: заказчик пока не сказал, что считать
        // «первым ответом» — любое дело по лиду или только исходящий контакт. Без ответа блок
        // честно сообщает, что данных не выбирали, вместо того чтобы показать ноль обработанных.
      })

      dataset.value = {
        leads: adapted.leads,
        deals: adapted.deals,
        dictionaries: adapted.dictionaries,
        currencyId: adapted.currencyId,
        period
      }
      warnings.value = adapted.warnings
      // Пусто за период — выясняем, есть ли лиды вообще. Один запрос на одну запись, и только
      // когда он действительно нужен.
      if (adapted.leads.length === 0) latestLeadDate.value = await fetchLatestLeadDate()
      // ⚠ Признак источника переключаем ПОСЛЕДНИМ и только при успехе: сбой на любом шаге выше
      // оставляет на экране демонстрационный набор, и он обязан остаться подписанным как демо.
      source.value = 'portal'
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      pending.value = false
    }
  }

  return { dataset, report, conversionBase, firstResponseSlaMinutes, pending, error, source, isDemo, warnings, latestLeadDate, load }
}
