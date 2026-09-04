import { mergeReasons } from '~/utils/reasonMerge'
import type { ConversionBase, ReportDataset, ReportMetrics, ReportPeriod } from '~/types/report'
import type { AdapterWarnings, B24CurrencyRow, B24LeadRow, B24StatusRow, B24DealRow } from '~/utils/b24Adapter'
import {
  adaptDeals,
  adaptDealsContext,
  adaptLeadCounts,
  adaptUnlinkedWonDeals,
  openLeadStatusIds,
  baseCurrency,
  lossStages,
  statusIdsBySemantic,
  statusNames
} from '~/utils/b24Adapter'
import {
  categoryListParams,
  dealContextBatch,
  dealStageBatch,
  dealsFromLeadsParams,
  dictionaryBatch,
  latestLeadParams,
  leadCountBatch,
  type BatchCommand,
  leadHistoryLeadParams,
  leadHistoryParams,
  unlinkedWonDealsParams
} from '~/utils/b24Query'
import { buildReport, buildReportFromAggregate, mergeProcessing, processingMetrics } from '~/utils/metrics'
import { leadsFromHistory, type B24LeadHistoryRow, type B24StageHistoryRow } from '~/utils/leadHistory'
import { periodLengthDays, resolvePreset } from '~/utils/period'
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
/**
 * До скольких дней фоновые выборки (блок 7 — сделки без лида, блок 6 — история стадий) стартуют
 * сами. 92 дня — квартал: ≈ 3 минуты на блок 7 и ≈ 6 на блок 6. Дальше — только по кнопке: год
 * стоил бы 12 и 24 минуты, и запускать это от случайного клика по «Текущий год» нельзя.
 * Порог — решение разработчика от 2026-09-04 (владельца не спрашивали), менять — одну константу.
 */
export const BACKGROUND_AUTO_MAX_DAYS = 92

/** Минут на 30 дней периода: справка блока 7 (≈ 5 500 строк) и история стадий (≈ 9 700 строк). */
export const UNLINKED_MINUTES_PER_MONTH = 1
export const PROCESSING_MINUTES_PER_MONTH = 2

export function useReportData() {
  /**
   * Знаменатель конверсий — `Лиды − Брак`, как в ТЗ от 2026-09-04.
   *
   * ✅ Решение владельца от 2026-09-04: считать по ТЗ и убрать переключатель из интерфейса.
   * История вопроса длинная (макет считал от всех лидов, 03.09 заказчик подтвердил макет, ТЗ
   * от 04.09 вернуло формулу «лиды без брака») — она в `docs/METRICS.md`. В ядре знаменатель
   * остаётся параметром `ConversionBase`: это чистая функция под тестом, и следующий разворот
   * этого вопроса — снова одна строка здесь, а не правка формул.
   */
  const conversionBase: ConversionBase = 'quality-leads'

  /**
   * Норматив первого ответа, минуты. Пусто — просроченные не считаем.
   *
   * ✅ 120 минут — норматив ЗАКАЗЧИКА (2026-09-03).
   *
   * ⚠ «Ответ» — перевод лида в стадию «взят в работу» (заказчик, 2026-09-04). Моменты переходов
   * живут в истории стадий, которую отчёт пока не выбирает (#26). До этого блок честно сообщает,
   * что данных о первом действии нет (`AdapterWarnings.firstResponseNotFetched`), а не показывает
   * ноль обработанных.
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
  /**
   * Фоновая выборка: стартует после основного отчёта, у неё свой индикатор, своя ошибка и
   * кнопка на длинном периоде. Заставлять руководителя ждать справку вместе с воронкой нельзя,
   * и основной отчёт от неё не зависит. Таких выборок две — блок 7 и история стадий блока 6, —
   * и правила у них одни: результат выборки, пережившей смену периода, выбрасывается; новая
   * основная выборка сбрасывает индикатор (иначе «Считаем…» от осиротевшей висело бы вечно).
   */
  function backgroundJob<Ctx>(run: (ctx: Ctx, mine: number) => Promise<void>) {
    const pending = ref(false)
    const error = ref<string | undefined>(undefined)
    const deferred = ref(false)
    let context: { ctx: Ctx, mine: number } | undefined
    async function go(): Promise<void> {
      if (!context || context.mine !== seq) return
      const { ctx, mine } = context
      deferred.value = false
      pending.value = true
      error.value = undefined
      try {
        await run(ctx, mine)
      } catch (e) {
        if (mine === seq) error.value = e instanceof Error ? e.message : String(e)
      } finally {
        if (mine === seq) pending.value = false
      }
    }
    return {
      pending,
      error,
      deferred,
      reset(): void {
        pending.value = false
        error.value = undefined
        deferred.value = false
        context = undefined
      },
      /** Запомнить, что считать; на коротком периоде — сразу, на длинном — ждать кнопки. */
      schedule(ctx: Ctx, mine: number, auto: boolean): void {
        context = { ctx, mine }
        if (auto) void go()
        else deferred.value = true
      },
      start(): void {
        void go()
      }
    }
  }
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
      conversionBase,
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
   * Постраничная выборка, которую МОЖНО бросить на полпути.
   *
   * ⚠ `callList` SDK отмены не знает: начатая выборка идёт до конца, даже если её результат уже
   * никому не нужен. Для фоновой справки блока 7 это ≈ 110 страниц на месяц и ≈ 1 300 на год —
   * каждая смена периода оставляла бы в портале ещё одну многоминутную выборку, и три быстрых
   * клика по периодам исчерпали бы лимит запросов портала для ОСНОВНОГО отчёта. Поэтому здесь
   * свой курсор по `ID` (тот же приём, что у `callList`: `start: -1` отключает подсчёт итога), и
   * между страницами спрашиваем, не устарела ли выборка.
   */
  async function fetchAllUntil<T extends { ID?: string | number }>(
    method: string,
    params: { select: string[], filter: Record<string, unknown>, [extra: string]: unknown },
    stale: () => boolean
  ): Promise<T[]> {
    const rows: T[] = []
    let lastId = 0
    while (!stale()) {
      const result = await b24.getOrThrow().actions.v2.call.make<T[]>({
        method,
        params: { ...params, order: { ID: 'ASC' }, filter: { ...params.filter, '>ID': lastId }, start: -1 }
      })
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      const page = result.getData()?.result
      if (!Array.isArray(page) || page.length === 0) break
      rows.push(...page)
      const last = Number(page[page.length - 1]?.ID)
      if (page.length < 50 || !Number.isFinite(last) || last <= lastId) break
      lastId = last
    }
    return rows
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
    // Фоновые выборки прошлого периода больше не наши — заново.
    unlinked.reset()
    processing.reset()
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
      const convertedStatusIds = statusIdsBySemantic(leadStatuses, 'S')
      const openStatusIds = openLeadStatusIds(leadStatuses)
      const sourceIds = sources.map(row => row.STATUS_ID).filter(Boolean)

      // Шаги 2–5 независимы друг от друга — идут параллельно. Последовательно они стоили бы ещё
      // 4–5 секунд поверх самого долгого шага (строки сделок), ожидая ничего.
      const [dealStages, leadTotals, dealRows, dealTotals] = await Promise.all([
        // 2. Стадии сделок ВСЕХ направлений: `DEAL_STAGE` — только направление по умолчанию,
        //    у заказчика их четыре. Без остальных причина проигрыша приедет кодом вместо названия.
        fetchCategoryIds().then(ids => batchRows<B24StatusRow>(dealStageBatch(ids))).then(books => Object.values(books).flat()),
        // 3. Лиды — счётчиками. Что спросить, знает `leadCountBatch`; что с этим делать — `adaptLeadCounts`.
        batchTotals(leadCountBatch(period, { junkStatusIds, sourceIds, openStatusIds })),
        // 4. Сделки из лидов — строками: ради выручки и причин проигрыша. Их ~10 % от всех.
        fetchAll<B24DealRow>('crm.deal.list', dealsFromLeadsParams(period)),
        // 5. Сделки всего портала — три счётчика, чтобы «успешных: 636» не читалось как «всего продаж».
        batchTotals(dealContextBatch(period))
      ])

      if (mine !== seq) return

      const leadAggregate = adaptLeadCounts({ totals: leadTotals, sourceIds, junkStatusIds, openStatusIds })
      // Одно сведение на прогон: из него и карта ключей для сделок, и словарь имён. Сводим
      // ТОЛЬКО стадии провала — «Новая» и «Успех» тоже продублированы по направлениям, и
      // счётчик свёрнутых стадий с ними внутри не сходился бы ни с чем.
      const reasons = mergeReasons(lossStages(dealStages))
      const adaptedDeals = adaptDeals(dealRows, currencies, reasons.keyByCode)
      const currencyId = baseCurrency(currencies)
      const dealsContext = adaptDealsContext(dealTotals)

      dataset.value = {
        leads: [],
        deals: adaptedDeals.deals,
        leadAggregate,
        allDeals: dealsContext,
        dictionaries: {
          sources: statusNames(sources),
          junkReasons: statusNames(leadStatuses),
          leadStages: statusNames(leadStatuses),
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
        // Время первого ответа приходит фоном из истории стадий; пока идёт — блок 6 говорит об
        // этом сам, общая оговорка не нужна.
        firstResponseNotFetched: false
      }
      // Пусто за период — выясняем, есть ли лиды вообще. Один запрос на одну запись, и только
      // когда он действительно нужен.
      if (leadAggregate.total === 0) {
        const latest = await fetchLatestLeadDate()
        if (mine !== seq) return
        latestLeadDate.value = latest
      }
      source.value = 'portal'
      // 6. Фоном, когда основной отчёт уже на экране; на длинном периоде — только по кнопке:
      //    успешные сделки БЕЗ лида (факт о процессе, который отчёт обязан показать: на боевом
      //    портале это 90 % сделок) и история стадий лидов — время первого ответа для блока 6.
      const auto = periodLengthDays(period) <= BACKGROUND_AUTO_MAX_DAYS
      unlinked.schedule({ period, currencies, sourceIds }, mine, auto)
      processing.schedule({ period, junkStatusIds, convertedStatusIds }, mine, auto)
    } catch (e) {
      if (mine === seq) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      // ⚠ Гасим индикатор только за СВОЙ запрос: иначе устаревший ответ снял бы «загружается» с
      // ещё идущей выборки, и экран замер бы со старыми числами без единого признака работы.
      if (mine === seq) pending.value = false
    }
  }

  /** Блок 7: успешные сделки без лида — строками, отменяемо. */
  const unlinked = backgroundJob<{ period: ReportPeriod, currencies: B24CurrencyRow[], sourceIds: string[] }>(async ({ period, currencies, sourceIds }, mine) => {
    const rows = await fetchAllUntil<B24DealRow>('crm.deal.list', unlinkedWonDealsParams(period), () => mine !== seq)
    if (mine !== seq) return
    dataset.value = { ...dataset.value, unlinkedDeals: adaptUnlinkedWonDeals(rows, currencies, sourceIds) }
  })

  /**
   * Блок 6: время первого ответа и просрочка — из истории стадий (#26).
   *
   * Две выборки подряд: строки лидов периода (когда создан, откуда) и переходы по стадиям. Из
   * них — те же строки лидов, что у демо-набора, и то же ядро `processingMetrics`. Числа
   * «обработано / не обработано» при этом остаются от счётчиков — см. `mergeProcessing`.
   */
  const processing = backgroundJob<{ period: ReportPeriod, junkStatusIds: string[], convertedStatusIds: string[] }>(async ({ period, junkStatusIds, convertedStatusIds }, mine) => {
    const stale = () => mine !== seq
    const leadRows = await fetchAllUntil<B24LeadHistoryRow>('crm.lead.list', leadHistoryLeadParams(period), stale)
    if (stale()) return
    const history = await fetchAllUntil<B24StageHistoryRow>('crm.stagehistory.list', leadHistoryParams(period), stale)
    if (stale()) return
    const leads = leadsFromHistory(leadRows, history, junkStatusIds, convertedStatusIds)
    // «Сейчас» для просрочки — конец периода, но не позже настоящего «сейчас»: в текущем месяце
    // лид, созданный час назад, ещё не просрочен, хотя до конца месяца далеко.
    const periodEnd = Date.parse(`${period.to}T23:59:59`)
    const now = new Date(Math.min(Date.now(), Number.isFinite(periodEnd) ? periodEnd : Date.now())).toISOString()
    const timed = processingMetrics(leads, { conversionBase, firstResponseSlaMinutes: firstResponseSlaMinutes.value, now })
    const aggregate = dataset.value.leadAggregate
    if (!aggregate?.processing) return
    dataset.value = { ...dataset.value, leadAggregate: { ...aggregate, processing: mergeProcessing(aggregate.processing, timed) } }
  })

  return {
    dataset,
    report,
    firstResponseSlaMinutes,
    pending,
    error,
    unlinkedPending: unlinked.pending,
    unlinkedError: unlinked.error,
    unlinkedDeferred: unlinked.deferred,
    startUnlinked: unlinked.start,
    processingPending: processing.pending,
    processingError: processing.error,
    processingDeferred: processing.deferred,
    startProcessing: processing.start,
    source,
    isDemo,
    warnings,
    latestLeadDate,
    load
  }
}
