import { mergeReasons } from '~/utils/reasonMerge'
import type { ConversionBase, ReportDataset, ReportMetrics, ReportPeriod } from '~/types/report'
import type { AdapterWarnings, B24CurrencyRow, B24LeadRow, B24StatusRow, B24DealRow } from '~/utils/b24Adapter'
import { adaptDeals, adaptDealsContext, adaptLeadCounts, baseCurrency, statusIdsBySemantic, statusNames, lossStages,
  adaptUnlinkedDeals } from '~/utils/b24Adapter'
import {
  type BatchCommand,
  categoryListParams,
  dealContextBatch,
  dealStageBatch,
  dealsFromLeadsParams,
  dictionaryBatch,
  latestLeadParams,
  leadCountBatch,
  unlinkedDealBatch } from '~/utils/b24Query'
import { buildReport, buildReportFromAggregate } from '~/utils/metrics'
import { resolvePreset } from '~/utils/period'
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

  const report = computed<ReportMetrics>(() => {
    const options = {
      conversionBase: conversionBase.value,
      firstResponseSlaMinutes: firstResponseSlaMinutes.value,
      now: dataset.value.period.to + 'T23:59:59Z'
    }
    // Живой портал приносит лиды ИТОГАМИ (счётчики), демо-набор — строками. Ядро одно, вход
    // разный; оба пути обязаны сходиться, и это закреплено тестом на `aggregateLeads`.
    const { leadAggregate, allDeals } = dataset.value
    return leadAggregate
      ? buildReportFromAggregate(leadAggregate, dataset.value.deals, options, allDeals)
      : buildReport(dataset.value.leads, dataset.value.deals, options)
  })

  const b24 = useB24()

  /**
   * Номер последней запрошенной выборки.
   *
   * ⚠ Период переключают кликами, и ответы приходят не в том порядке, в каком их спросили.
   * Медленный ответ прошлого периода, придя последним, затёр бы быстрый ответ нового — на экране
   * оказались бы данные одного периода под подписью другого. Заметить такое можно только сверкой
   * с CRM вручную.
   */
  let seq = 0

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

  /**
   * Пакет команд → результат каждой по её ключу.
   *
   * ⚠ Команды режутся по 50: это предел одного пакета у портала, а именованные команды SDK умеет
   * только в `batch`, не в `batchByChunk`. Число источников у клиента задаёт размер пакета
   * счётчиков, и 14 источников — это ровно 50 команд; пятнадцатый молча вылетел бы за предел.
   */
  async function batchResults<T>(commands: Record<string, BatchCommand>): Promise<Record<string, { data: T | undefined, total: number }>> {
    const entries = Object.entries(commands)
    const out: Record<string, { data: T | undefined, total: number }> = {}
    for (let i = 0; i < entries.length; i += 50) {
      const chunk = Object.fromEntries(entries.slice(i, i + 50))
      const result = await b24.getOrThrow().actions.v2.batch.make<T>({
        calls: chunk,
        options: { isHaltOnError: false, returnAjaxResult: true }
      })
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      const data = result.getData()
      if (typeof data !== 'object' || data === null) continue
      for (const [key, ajax] of Object.entries(data as Record<string, { getData?: () => { result?: T } | undefined, getTotal?: () => number }>)) {
        out[key] = { data: ajax.getData?.()?.result, total: ajax.getTotal?.() ?? 0 }
      }
    }
    return out
  }

  /** Только `total` каждой команды — для счётчиков. */
  async function batchTotals(commands: Record<string, BatchCommand>): Promise<Record<string, number>> {
    const results = await batchResults<unknown>(commands)
    return Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.total]))
  }

  /** Только строки каждой команды — для справочников. */
  async function batchRows<T>(commands: Record<string, BatchCommand>): Promise<Record<string, T[]>> {
    const results = await batchResults<T[]>(commands)
    return Object.fromEntries(Object.entries(results).map(([key, value]) => [key, Array.isArray(value.data) ? value.data : []]))
  }

  /** Идентификаторы направлений сделок. Ошибка — пустой список: тогда прочитаем хотя бы направление по умолчанию. */
  async function fetchCategoryIds(): Promise<number[]> {
    try {
      const result = await b24.getOrThrow().actions.v2.call.make<{ categories?: Array<{ id?: unknown }> }>({
        method: 'crm.category.list',
        params: categoryListParams()
      })
      const categories = result.getData()?.result?.categories
      if (!Array.isArray(categories)) return []
      return categories.map(c => Number(c?.id)).filter(id => Number.isFinite(id) && id > 0)
    } catch {
      return []
    }
  }

  /** Дата создания самого свежего лида портала, если он есть. Ошибку глушим: это подсказка. */
  async function fetchLatestLeadDate(): Promise<string | undefined> {
    try {
      const result = await b24.getOrThrow().actions.v2.call.make<B24LeadRow[]>({
        method: 'crm.lead.list',
        params: latestLeadParams()
      })
      // ⚠ `getData()` отдаёт конверт `{ result, time }`, а не сами строки. Проверка `Array.isArray`
      // прямо на конверте была всегда ложной — и подсказка о последнем лиде не работала никогда.
      const rows = result.getData()?.result
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
  async function load(period: ReportPeriod = resolvePreset('this-month', new Date())!): Promise<void> {
    await b24.init()
    if (!b24.isInit()) return

    const mine = ++seq
    pending.value = true
    error.value = undefined
    try {
      /**
       * Порядок шагов и почему именно так — см. `docs/PORTAL.md` § «Что делать с объёмами».
       * Коротко: на боевом портале 3 851 лид и 10 178 сделок в месяц. Строками это 2,5 минуты
       * ожидания, счётчиками и сделками ТОЛЬКО ИЗ ЛИДОВ — секунд десять.
       */

      // 1. Справочники: валюты, источники, стадии лида — одним пакетом.
      const books = await batchRows<B24StatusRow | B24CurrencyRow>(dictionaryBatch())
      const currencies = (books.currencies ?? []) as B24CurrencyRow[]
      const sources = (books.sources ?? []) as B24StatusRow[]
      const leadStatuses = (books.leadStatuses ?? []) as B24StatusRow[]

      const junkStatusIds = statusIdsBySemantic(leadStatuses, 'F')
      const sourceIds = sources.map(row => row.STATUS_ID).filter(Boolean)

      // Шаги 2–5 независимы друг от друга — идут параллельно. Последовательно они стоили бы ещё
      // 4–5 секунд поверх самого долгого шага (строки сделок), ожидая ничего.
      const [dealStages, leadTotals, dealRows, dealTotals, unlinkedTotals] = await Promise.all([
        // 2. Стадии сделок ВСЕХ направлений: `DEAL_STAGE` — только направление по умолчанию,
        //    у заказчика их четыре. Без остальных причина проигрыша приедет кодом вместо названия.
        fetchCategoryIds().then(ids => batchRows<B24StatusRow>(dealStageBatch(ids))).then(books => Object.values(books).flat()),
        // 3. Лиды — счётчиками. Что спросить, знает `leadCountBatch`; что с этим делать — `adaptLeadCounts`.
        batchTotals(leadCountBatch(period, { junkStatusIds, sourceIds })),
        // 4. Сделки из лидов — строками: ради выручки и причин проигрыша. Их ~10 % от всех.
        fetchAll<B24DealRow>('crm.deal.list', dealsFromLeadsParams(period)),
        // 5. Сделки всего портала — три счётчика, чтобы «успешных: 636» не читалось как «всего продаж».
        batchTotals(dealContextBatch(period)),
        // 6. Сделки БЕЗ лида по источникам — факт о процессе, который отчёт обязан показать,
        //    а не спрятать в оговорку: на боевом портале это 90 % сделок.
        batchTotals(unlinkedDealBatch(period, sourceIds))
      ])

      if (mine !== seq) return

      const leadAggregate = adaptLeadCounts({ totals: leadTotals, sourceIds, junkStatusIds })
      // Одно сведение на прогон: из него и карта ключей для сделок, и словарь имён. Сводим
      // ТОЛЬКО стадии провала — «Новая» и «Успех» тоже продублированы по направлениям, и
      // счётчик свёрнутых стадий с ними внутри не сходился бы ни с чем.
      const reasons = mergeReasons(lossStages(dealStages))
      const adaptedDeals = adaptDeals(dealRows, currencies, reasons.keyByCode)
      const currencyId = baseCurrency(currencies)

      dataset.value = {
        leads: [],
        deals: adaptedDeals.deals,
        leadAggregate,
        allDeals: adaptDealsContext(dealTotals),
        unlinkedDeals: adaptUnlinkedDeals(unlinkedTotals, sourceIds),
        dictionaries: {
          sources: statusNames(sources),
          junkReasons: statusNames(leadStatuses),
          lossReasons: reasons.names
        },
        currencyId,
        period
      }
      warnings.value = {
        mergedLossReasons: reasons.foldedCodes,
        unconvertedDeals: adaptedDeals.unconvertedDeals,
        dealsWithoutLead: adaptedDeals.dealsWithoutLead,
        duplicateIds: adaptedDeals.duplicateIds,
        wonWithoutAmount: adaptedDeals.wonWithoutAmount,
        // Счётчики не видят связи лид → сделка поимённо, поэтому эти две оговорки здесь не считаются.
        wonStageWithoutDeal: 0,
        dealsWithMissingLead: 0,
        // ⚠ Время первого ответа не выбирается намеренно: заказчик пока не сказал, что считать
        // «первым ответом». Без ответа блок честно молчит, а не показывает ноль обработанных.
        firstResponseNotFetched: true
      }
      // Пусто за период — выясняем, есть ли лиды вообще. Один запрос на одну запись, и только
      // когда он действительно нужен.
      if (leadAggregate.total === 0) {
        const latest = await fetchLatestLeadDate()
        if (mine !== seq) return
        latestLeadDate.value = latest
      }
      source.value = 'portal'
    } catch (e) {
      if (mine === seq) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      // ⚠ Гасим индикатор только за СВОЙ запрос: иначе устаревший ответ снял бы «загружается» с
      // ещё идущей выборки, и экран замер бы со старыми числами без единого признака работы.
      if (mine === seq) pending.value = false
    }
  }

  return { dataset, report, conversionBase, firstResponseSlaMinutes, pending, error, source, isDemo, warnings, latestLeadDate, load }
}
