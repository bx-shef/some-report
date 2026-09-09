// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useReportData } from '~/composables/useReportData'
import { leadCountKey } from '~/utils/b24Adapter'

/**
 * Загрузка живых данных: порядок вызовов и гонка ответов.
 *
 * ⚠ Гонка — единственное, от чего защищает счётчик `seq`, и её нельзя увидеть глазами: медленный
 * ответ прошлого периода, придя последним, положил бы на экран числа одного периода под подписью
 * другого. Заметить такое можно только сверкой с CRM вручную — поэтому она под тестом.
 */
const portal = vi.hoisted(() => ({
  initialized: true,
  /** Сколько лидов «нашёл» портал за период. Ноль включает подсказку о последнем лиде. */
  leadTotal: 7,
  /** Отложенные ответы постраничной выборки по периоду: тест сам решает, кто ответит первым. */
  pending: {} as Record<string, (rows: unknown[] | Error) => void>,
  /**
   * Полные наборы строк выборок, читаемых СМЕЩЕНИЕМ: тест отдаёт их разом, стенд сам режет на
   * страницы. Иначе тесту пришлось бы отвечать на каждую страницу отдельно, а проверяет он не это.
   */
  paged: {} as Record<string, unknown[]>,
  /** Ключи страниц, спрошенных пакетом, — чтобы видеть, что читалось смещением, а не курсором. */
  pagedCalls: [] as string[],
  /** Ключи команд, на которые портал «не ответит»: так выглядит упёршаяся в лимит команда. */
  dropPages: [] as string[],
  /** Отдать страницу в конверте `{ items }` — как это делает `crm.stagehistory.list`. */
  itemsEnvelope: false,
  /** Подменить `total` портала: так выглядит испорченный или неожиданно огромный счётчик. */
  fakeTotal: undefined as number | undefined,
  calls: [] as string[],
  /** Фильтр каждого построчного запроса по его ключу — чтобы видеть, что именно спросили. */
  filters: {} as Record<string, Record<string, unknown>>,
  /** Фильтры команд последнего пакета счётчиков лидов. */
  batchFilters: {} as Record<string, Record<string, unknown>>,
  /** Уволенные — их портал отдаёт только по `user.get` с `ACTIVE: false`. */
  dismissedUsers: [] as Array<Record<string, unknown>>,
  /**
   * Штат портала. Читает его `callList` (полная выборка SDK); одиночный `user.get` — ловушка,
   * отдающая только первую полусотню, чтобы возврат к ручному листанию было видно.
   */
  users: [] as Array<{ ID: string, NAME?: string, LAST_NAME?: string }>,
  /** `user.get` падает (нет права) — отчёт от этого страдать не должен. */
  usersFail: false,
  /** Счётчики лидов по ключам пакета: `src:CALL` и прочие. Чего нет — ноль. */
  counters: {} as Record<string, number>,
  /** Справочники портала — чтобы пакет счётчиков строил и пофакторные команды. */
  sources: [{ STATUS_ID: 'CALL', NAME: 'Звонок' }, { STATUS_ID: 'EMAIL', NAME: 'Почта' }],
  leadStatuses: [
    { STATUS_ID: 'NEW', NAME: 'Новый', SEMANTICS: '' },
    { STATUS_ID: '1', NAME: 'В работе', SEMANTICS: '' },
    { STATUS_ID: 'JUNK', NAME: 'Спам', SEMANTICS: 'F' },
    { STATUS_ID: 'OTHER', NAME: 'Нецелевой', SEMANTICS: 'F' },
    { STATUS_ID: 'CONVERTED', NAME: 'Сделка', SEMANTICS: 'S' }
  ]
}))

/**
 * Ключ выборки, которую отчёт читает СМЕЩЕНИЕМ: успешные сделки без лида и строки лидов.
 *
 * ⚠ Обе узнаются по фильтру, а не по методу: `crm.deal.list` под фильтром лида читается
 * курсором кусками по `LEAD_ID`, и спутать их нельзя.
 */
function pagedKey(method: string, filter: Record<string, unknown>): string | undefined {
  if (method === 'crm.deal.list' && !Array.isArray(filter.LEAD_ID) && filter['>=CLOSEDATE']) {
    return `closed:${String(filter['>=CLOSEDATE'])}`
  }
  if (method === 'crm.lead.list' && filter['>=DATE_CREATE']) return `leads:${String(filter['>=DATE_CREATE'])}`
  return undefined
}

/** Пустой, но исправный ответ пакета: у каждой команды `getTotal()` и `getData()`. */
function batchAnswer(commands: Record<string, unknown>) {
  const data: Record<string, { getTotal: () => number, getData: () => { result: unknown[] } }> = {}
  for (const [key, command] of Object.entries(commands)) {
    const filter = (command as { params?: { filter?: Record<string, unknown> } }).params?.filter
    if (filter && ('>=DATE_CREATE' in filter)) portal.batchFilters[key] = filter
    // Страницы выборки смещением: `p<номер>` с параметром `start`. Режем из полного набора —
    // ⚠ ровно как портал: страница за пределами набора это ПУСТОТА, а не ошибка.
    const params = (command as { method?: string, params?: { start?: number } }).params
    const pageKey = pagedKey((command as { method?: string }).method ?? '', filter ?? {})
    if (key.startsWith('p') && pageKey && typeof params?.start === 'number') {
      const all = portal.paged[pageKey] ?? []
      portal.pagedCalls.push(`${pageKey}#${params.start}`)
      // ⚠ Как портал с `isHaltOnError: false`: команда, упёршаяся в лимит, просто ОТСУТСТВУЕТ в
      // ответе. Не пустой массив, не ошибка — её ключа нет вовсе.
      if (portal.dropPages.includes(key)) continue
      const slice = all.slice(params.start, params.start + 50)
      data[key] = { getTotal: () => all.length, getData: () => ({ result: slice }) }
      continue
    }
    const rows = key === 'sources' ? portal.sources : key === 'leadStatuses' ? portal.leadStatuses : []
    data[key] = {
      getTotal: () => portal.counters[key] ?? (key === 'total' ? portal.leadTotal : key === 'unprocessed' ? Math.min(2, portal.leadTotal) : 0),
      getData: () => ({ result: rows })
    }
  }
  return { isSuccess: true, getData: () => data, getErrorMessages: () => [] }
}

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => portal.initialized,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  getOrThrow: () => ({
    actions: {
      v2: {
        batch: { make: async ({ calls }: { calls: Record<string, unknown> }) => batchAnswer(calls) },
        call: {
          make: ({ method, params }: { method: string, params: { filter?: Record<string, string> } }) => {
            // Справка блока 7 — своим курсором по ID (отменяемая выборка), страница за страницей.
            // Курсорные выборки (`start: -1`): справка блока 7, строки лидов и история стадий блока 6.
            const cursor = (params as { start?: number }).start === -1
            const history = method === 'crm.stagehistory.list'
            // Под фильтром по полям лида: сначала ID лидов (select только ID), потом сделки по
            // списку — свои ключи, чтобы тест видел, что именно спросили.
            const leadIds = (params.filter as { LEAD_ID?: unknown })?.LEAD_ID
            const onlyId = ((params as { select?: string[] }).select ?? []).join(',') === 'ID'
            const key = method === 'crm.deal.list'
              ? Array.isArray(leadIds) ? `deals-by:${leadIds.join(',')}` : `closed:${params.filter?.['>=CLOSEDATE'] ?? '?'}`
              : history
                ? `${(params.filter as { TYPE_ID?: unknown })?.TYPE_ID === 1 ? 'created' : 'history'}:${params.filter?.['>=CREATED_TIME'] ?? '?'}`
                : cursor && method === 'crm.lead.list'
                  // Источники лидов узнаются по `SOURCE_ID` в `select`: своя выборка, свой ключ.
                  ? `${((params as { select?: string[] }).select ?? []).includes('SOURCE_ID') ? 'lead-sources' : onlyId ? 'ids' : 'leads'}:${params.filter?.['>=DATE_CREATE'] ?? '?'}`
                  : undefined

            /**
             * ПЕРВАЯ страница выборки, читаемой смещением: тест отдаёт весь набор разом, стенд
             * режет сам и сообщает `total`.
             *
             * ⚠ Стенд обязан быть НЕ ЩЕДРЕЕ SDK: `getData()` отдаёт КОНВЕРТ `{ result }` со
             * страницей, а не весь набор, а общее число доступно ТОЛЬКО через `getTotal()`.
             * Отдай он здесь всё разом — тест остался бы зелёным при выборке, читающей одну
             * страницу из ста, то есть при ровно том дефекте, который уже был с сотрудниками.
             */
            const pageStart = (params as { start?: number }).start
            const headKey = pageStart === 0 ? pagedKey(method, (params.filter ?? {}) as Record<string, unknown>) : undefined
            if (headKey) {
              portal.calls.push(headKey)
              portal.filters[headKey] = params.filter ?? {}
              return new Promise((resolve) => {
                portal.pending[headKey] = (rows) => {
                  if (rows instanceof Error) {
                    resolve({ isSuccess: false, getData: () => undefined, getTotal: () => 0, getErrorMessages: () => [rows.message] })
                    return
                  }
                  portal.paged[headKey] = rows
                  const page = rows.slice(0, 50)
                  resolve({
                    isSuccess: true,
                    getData: () => ({ result: portal.itemsEnvelope ? { items: page } : page }),
                    getTotal: () => portal.fakeTotal ?? rows.length,
                    getErrorMessages: () => []
                  })
                }
              })
            }
            if (method === 'user.get') {
              // ⛔ ЛОВУШКА, а не рабочий путь. Сотрудников читает `callList` (ниже), а здесь
              // одиночный вызов отвечает ТОЧНО как настоящий SDK: `getData()` отдаёт
              // `{ result }` и НИКАКОГО `next` — `AjaxResult.getData()` его срезает
              // (`Object.freeze({ result, time })`), он доступен лишь через `isMore()`.
              //
              // ⚠ Прежде этот стенд возвращал `next` из `getData()` — и был ЩЕДРЕЕ реальности.
              // Из-за этого тест на 60 сотрудников был зелёным, а на боевом портале в отчёт
              // попадали ровно 50: самодельный цикл читал несуществующее поле и заканчивался
              // после первой страницы. Верни кто-нибудь ручное листание — эта ветка отдаст ему
              // одну страницу, и тест ниже покраснеет.
              portal.calls.push('user.get:одиночный')
              if (portal.usersFail) return Promise.reject(new Error('insufficient_scope'))
              const active = (params as { filter?: { ACTIVE?: unknown } }).filter?.ACTIVE !== false
              const page = (active ? portal.users : portal.dismissedUsers).slice(0, 50)
              return Promise.resolve({ isSuccess: true, getData: () => ({ result: page }), getErrorMessages: () => [] })
            }
            if (key) {
              portal.calls.push(key)
              portal.filters[key] = params.filter ?? {}
              return new Promise((resolve) => {
                portal.pending[key] = rows => resolve(rows instanceof Error
                  ? { isSuccess: false, getData: () => undefined, getErrorsByKey: () => ({}), getErrorMessages: () => [rows.message] }
                  // ⚠ Как живой портал: история отдаёт `result.items`, списки CRM — `result: [...]`.
                  : { isSuccess: true, getData: () => ({ result: history ? { items: rows } : rows }), getErrorMessages: () => [] })
              })
            }
            return Promise.resolve({
              isSuccess: true,
              // ⚠ Как и живой SDK: `getData()` отдаёт КОНВЕРТ `{ result }`, а не сами строки.
              getData: () => ({
                result: method === 'crm.lead.list'
                  ? [{ ID: '5', DATE_CREATE: '2026-08-17T10:00:00+03:00' }]
                  : { categories: [] }
              }),
              getErrorMessages: () => []
            })
          }
        },
        callList: {
          make: ({ method, params }: { method: string, params: { filter: Record<string, unknown> } }) => {
            // ⚠ Полная выборка SDK: он листает сам и отдаёт ВСЕ строки одним массивом. Именно
            // так читаются сотрудники — и лиды со сделками ниже.
            if (method === 'user.get') {
              portal.calls.push('user.get')
              if (portal.usersFail) return Promise.reject(new Error('insufficient_scope'))
              // ⚠ Как живой портал: `ACTIVE` в фильтре разделяет работающих и уволенных. Стенд,
              // отдающий на оба запроса один список, пометил бы уволенными всех подряд.
              const active = (params as unknown as { filter?: { ACTIVE?: unknown } }).filter?.ACTIVE !== false
              const all = active ? portal.users : portal.dismissedUsers
              return Promise.resolve({ isSuccess: true, getData: () => all, getErrorMessages: () => [] })
            }
            const from = String(params.filter['>=DATE_CREATE'] ?? '?')
            // Под фильтром по полям лида: сначала ID лидов, потом сделки по списку — свои ключи.
            const leadIds = params.filter.LEAD_ID
            const key = method === 'crm.lead.list' ? `ids:${from}` : Array.isArray(leadIds) ? `deals-by:${leadIds.join(',')}` : from
            portal.calls.push(key)
            portal.filters[key] = params.filter
            return new Promise((resolve) => {
              portal.pending[key] = rows => resolve(rows instanceof Error
                ? { isSuccess: false, getData: () => undefined, getErrorsByKey: () => ({}), getErrorMessages: () => [rows.message] }
                : { isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
            })
          }
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.initialized = true
  portal.leadTotal = 7
  portal.pending = {}
  portal.paged = {}
  portal.pagedCalls = []
  portal.dropPages = []
  portal.itemsEnvelope = false
  portal.fakeTotal = undefined
  portal.calls = []
  portal.filters = {}
  portal.batchFilters = {}
  portal.users = []
  portal.dismissedUsers = []
  portal.usersFail = false
})

const AUGUST = { from: '2026-08-01', to: '2026-08-31' }
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' }

describe('load', () => {
  it('вне портала не трогает REST и оставляет демо-набор', async () => {
    portal.initialized = false
    const data = useReportData()
    await data.load(AUGUST)
    expect(portal.calls).toEqual([])
    expect(data.isDemo.value).toBe(true)
  })

  /**
   * ⛔ Живой путь разреза источников. Дефект, который этот тест сторожит, стоил ВСЕЙ выручки
   * блока 5: замер боевого портала 2026-09-09 — за 1–9 сентября 14 861,98 BYN на 20 успешных
   * сделках уходили в «Другие источники» вместо «Звонка» и почты.
   *
   * Причина: «Заказ покупателя» из 1С приходит БЕЗ источника и привязывается к лиду руками,
   * окном «Подбор сделки». Разрез брал источник у самой сделки — там пусто.
   *
   * ⚠ Чистые функции это не ловят: удали строку, которая кладёт карту в агрегат, — и все они
   * останутся зелёными. Ровно так и вышло при проверке саботажем, поэтому тест здесь.
   */
  it('выручка ложится на источник ЛИДА: карта источников спрашивается и доезжает до разреза', async () => {
    portal.counters = { 'src:CALL': 1, 'srcConv:CALL': 1, 'converted': 1 }
    portal.leadTotal = 1
    const data = useReportData()
    const loading = data.load(AUGUST)
    // Сделка из лида: успешная, с деньгами и БЕЗ своего источника.
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([
      { ID: '900', LEAD_ID: '77', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '1206.51', CURRENCY_ID: 'BYN', SOURCE_ID: '' }
    ])
    // Раз у сделки источника нет — отчёт обязан спросить источник её ЛИДА.
    await vi.waitFor(() => expect(portal.pending[`lead-sources:${AUGUST.from}`]).toBeDefined())
    expect(portal.filters[`lead-sources:${AUGUST.from}`]).toMatchObject({ ID: [77] })
    portal.pending[`lead-sources:${AUGUST.from}`]!([{ ID: '77', SOURCE_ID: 'CALL' }])
    await loading

    expect(data.dataset.value.leadAggregate?.leadSourceById).toEqual({ 77: 'CALL' })
    const call = data.report.value.bySource.find(row => row.sourceId === 'CALL')
    expect(call).toMatchObject({ leads: 1, won: 1 })
    expect(call?.revenue).toBeCloseTo(1206.51, 2)
  })

  it('после загрузки источник — портал, период — запрошенный', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading
    expect(data.isDemo.value).toBe(false)
    expect(data.dataset.value.period).toEqual(AUGUST)
    expect(data.dataset.value.leadAggregate?.total).toBe(7)
    expect(data.pending.value).toBe(false)
  })

  // Блок «Успешные сделки без связи с лидом» существует только у портала и грузится ФОНОМ:
  // основной отчёт готов раньше, чем придут ≈ 5 500 строк справки.
  it('сделки без лида: на демо отсутствуют, на портале приходят фоном после основного отчёта', async () => {
    portal.initialized = false
    const demo = useReportData()
    await demo.load(AUGUST)
    expect(demo.dataset.value.unlinkedDeals).toBeUndefined()
    expect(demo.unlinkedPending.value).toBe(false)

    portal.initialized = true
    const live = useReportData()
    const loading = live.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading
    // Основной отчёт готов, справка ещё считается — и об этом сказано отдельным флагом.
    expect(live.pending.value).toBe(false)
    expect(live.isDemo.value).toBe(false)
    expect(live.unlinkedPending.value).toBe(true)
    expect(live.dataset.value.unlinkedDeals).toBeUndefined()

    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
    portal.pending[`closed:${AUGUST.from}`]!([{ ID: '1', SOURCE_ID: '', OPPORTUNITY: '500', CURRENCY_ID: 'BYN' }])
    await vi.waitFor(() => expect(live.unlinkedPending.value).toBe(false))
    expect(live.dataset.value.unlinkedDeals?.total).toBe(1)
    expect(live.dataset.value.unlinkedDeals?.revenue).toBe(500)
  })

  /**
   * ⛔ Сторож ЦЕЛОСТНОСТИ выборки смещением. Ровно этот дефект уже стоил отчёту 2 двухсот
   * фамилий: чтение заканчивалось после ПЕРВОЙ страницы, а числа при этом выглядели
   * правдоподобно — просто меньше. Здесь он был бы не виден тем более: справка блока 7 идёт
   * фоном, и «выручка за месяц 500 вместо 60 000» ничем себя не выдаёт.
   *
   * 120 сделок — это три страницы: первая одиночным запросом, ещё две пакетом.
   */
  it('справка блока 7 читается ЦЕЛИКОМ, а не первой страницей', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading

    const deals = Array.from({ length: 120 }, (_, index) => ({
      ID: String(index + 1), SOURCE_ID: '', OPPORTUNITY: '100', CURRENCY_ID: 'BYN'
    }))
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
    portal.pending[`closed:${AUGUST.from}`]!(deals)
    await vi.waitFor(() => expect(data.unlinkedPending.value).toBe(false))

    expect(data.dataset.value.unlinkedDeals?.total).toBe(120)
    expect(data.dataset.value.unlinkedDeals?.revenue).toBe(12_000)
    // Страницы спрошены СМЕЩЕНИЕМ, а не курсором: 50 и 100 — вторая и третья.
    expect(portal.pagedCalls).toContain(`closed:${AUGUST.from}#50`)
    expect(portal.pagedCalls).toContain(`closed:${AUGUST.from}#100`)
  })

  // ⚠ Смена периода, пока справка за прошлый период ещё идёт: её ответ обязан пропасть, иначе
  // под сентябрьской воронкой окажется августовский блок 7.
  it('ответ справки за прошлый период после смены периода выбрасывается', async () => {
    const data = useReportData()
    const first = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await first
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())

    const second = data.load(SEPTEMBER)
    await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
    // Августовская справка отвечает ПОСЛЕ того, как спросили сентябрь.
    portal.pending[`closed:${AUGUST.from}`]!([{ ID: '1', SOURCE_ID: '', OPPORTUNITY: '500' }])
    portal.pending[SEPTEMBER.from]!([])
    await second
    expect(data.dataset.value.period).toEqual(SEPTEMBER)
    expect(data.dataset.value.unlinkedDeals).toBeUndefined()
    await vi.waitFor(() => expect(portal.pending[`closed:${SEPTEMBER.from}`]).toBeDefined())
    portal.pending[`closed:${SEPTEMBER.from}`]!([])
    await vi.waitFor(() => expect(data.unlinkedPending.value).toBe(false))
    expect(data.dataset.value.unlinkedDeals?.total).toBe(0)
  })

  /**
   * ⛔ Пакет уходит с `isHaltOnError: false`: команда, упёршаяся в лимит интенсивности, просто
   * ОТСУТСТВУЕТ в ответе. Полсотни пропавших сделок — это недостача в ВЫРУЧКЕ, и выглядит она
   * совершенно правдоподобно: просто число меньше. Отчёт обязан сказать «не удалось», а не
   * показать часть денег как целое.
   */
  it('страница, на которую портал не ответил, роняет справку, а не занижает выручку', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading

    portal.dropPages = ['p1']
    const deals = Array.from({ length: 120 }, (_, index) => ({
      ID: String(index + 1), SOURCE_ID: '', OPPORTUNITY: '100', CURRENCY_ID: 'BYN'
    }))
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
    portal.pending[`closed:${AUGUST.from}`]!(deals)

    await vi.waitFor(() => expect(data.unlinkedError.value).toBeTruthy())
    // Именно НЕТ чисел, а не «есть, но меньше»: 70 из 120 выглядели бы как настоящая выручка.
    expect(data.dataset.value.unlinkedDeals).toBeUndefined()
  })

  /**
   * ⚠ Отмена проверяется МЕЖДУ пакетами, и до этого теста её не проверял никто: прежний тест
   * отдавал ровно 50 строк, а это ранний выход ещё до цикла пакетов. 120 строк дают три
   * страницы, то есть цикл действительно исполняется.
   */
  it('смена периода останавливает выборку между пакетами', async () => {
    const data = useReportData()
    const first = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await first
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())

    // Период сменился ДО того, как августовская справка отдала свою первую страницу.
    const second = data.load(SEPTEMBER)
    await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
    portal.pending[SEPTEMBER.from]!([])
    await second

    const many = () => Array.from({ length: 120 }, (_, index) => ({
      ID: String(index + 1), SOURCE_ID: '', OPPORTUNITY: '100', CURRENCY_ID: 'BYN'
    }))
    portal.pagedCalls = []
    portal.pending[`closed:${AUGUST.from}`]!(many())

    // ⚠ Ждём, пока пакетный цикл СЕНТЯБРЯ действительно пойдёт: без этого тест судил бы об
    // августе раньше, чем тот успел бы спросить хоть страницу, и оставался бы зелёным со снятой
    // проверкой `stale()`. Проверено ломкой.
    await vi.waitFor(() => expect(portal.pending[`closed:${SEPTEMBER.from}`]).toBeDefined())
    portal.pending[`closed:${SEPTEMBER.from}`]!(many())
    await vi.waitFor(() => expect(portal.pagedCalls.some(c => c.startsWith(`closed:${SEPTEMBER.from}`))).toBe(true))

    // Ни одной страницы устаревшего периода пакетом не спрошено.
    expect(portal.pagedCalls.filter(c => c.startsWith(`closed:${AUGUST.from}`))).toEqual([])
  })

  /**
   * ⚠ Списки CRM отдают `result: [...]`, а `crm.stagehistory.list` — `result: { items: [...] }`.
   * Сюда ходят только первые. «Непонятный конверт → пустой массив» означало бы справку, тихо
   * показавшую нулевую выручку при совершенно исправном портале.
   */
  it('чужой конверт ответа роняет справку, а не даёт нулевую выручку', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading

    portal.itemsEnvelope = true
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
    portal.pending[`closed:${AUGUST.from}`]!([{ ID: '1', SOURCE_ID: '', OPPORTUNITY: '500', CURRENCY_ID: 'BYN' }])

    await vi.waitFor(() => expect(data.unlinkedError.value).toBeTruthy())
    expect(data.dataset.value.unlinkedDeals).toBeUndefined()
  })

  /**
   * ⚠ Число страниц берёт из `total`, который отдаёт ПОРТАЛ. Испорченный счётчик увёл бы отчёт в
   * тысячи запросов и исчерпал лимит интенсивности для всех, кто в эту минуту работает в CRM.
   *
   * ⚠ И упереться в предел значит УПАСТЬ, а не показать что успели: строки идут в выручку.
   */
  it('неправдоподобно большой total роняет справку, а не уходит в тысячи запросов', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading

    portal.fakeTotal = 10_000_000
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
    portal.pending[`closed:${AUGUST.from}`]!([{ ID: '1', SOURCE_ID: '', OPPORTUNITY: '500', CURRENCY_ID: 'BYN' }])

    await vi.waitFor(() => expect(data.unlinkedError.value).toBeTruthy())
    expect(data.dataset.value.unlinkedDeals).toBeUndefined()
    // Ни одной страницы спрошено не было: предел проверяется ДО первого пакета.
    expect(portal.pagedCalls).toEqual([])
  })

  /**
   * ⚠ Уход со страницы обязан остановить фоновый проход, а не только выбросить его результат.
   * Справка живёт секундами и продолжала бы слать запросы в портал уже после того, как её никто
   * не ждёт. У портала предел интенсивности: тратить его на закрытую страницу значит отнимать у
   * той, что открыта сейчас.
   */
  it('уход со страницы останавливает фоновую справку', async () => {
    const scope = effectScope()
    let data!: ReturnType<typeof useReportData>
    scope.run(() => {
      data = useReportData()
    })

    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())

    // Страницу закрыли ровно в тот момент, когда справка получила первую страницу.
    scope.stop()
    portal.pagedCalls = []
    portal.pending[`closed:${AUGUST.from}`]!(Array.from({ length: 120 }, (_, index) => ({
      ID: String(index + 1), SOURCE_ID: '', OPPORTUNITY: '100', CURRENCY_ID: 'BYN'
    })))
    /**
     * ⚠ Даём циклу несколько оборотов событий: стенд отвечает мгновенно, и без этой паузы тест
     * судил бы о пакете раньше, чем тот успел бы уйти, — то есть оставался бы зелёным со снятой
     * отменой. Проверено ломкой.
     */
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(portal.pagedCalls).toEqual([])
  })

  // ⚠ Устаревшая выборка обязана ОСТАНОВИТЬСЯ, а не только выбросить результат: год — это
  // ≈ 1 300 страниц, и три быстрых клика по периодам исчерпали бы лимит запросов портала.
  it('осиротевшая справка не запрашивает следующую страницу', async () => {
    const data = useReportData()
    const first = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await first
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
    const calls = portal.calls.filter(c => c === `closed:${AUGUST.from}`).length

    const second = data.load(SEPTEMBER)
    await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
    // Полная страница из 50 строк обещает продолжение — но выборка уже чужая.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({ ID: String(i + 1), SOURCE_ID: '', OPPORTUNITY: '1' }))
    portal.pending[`closed:${AUGUST.from}`]!(fullPage)
    portal.pending[SEPTEMBER.from]!([])
    await second
    await vi.waitFor(() => expect(portal.pending[`closed:${SEPTEMBER.from}`]).toBeDefined())
    expect(portal.calls.filter(c => c === `closed:${AUGUST.from}`).length).toBe(calls)
  })

  // Блок 6: «обработано» — сразу, счётчиком NEW; время и просрочка — фоном, из строк лидов и
  // истории стадий, тем же ядром, что считает демо-набор.
  it('обработка лидов: счётчики сразу, время первого ответа — после истории стадий', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading
    // Счётчики: всего 7, в «Не обработан» 2 → обработано 5, время ещё не известно.
    expect(data.report.value.processing).toMatchObject({ processed: 5, unprocessed: 2 })
    expect(data.report.value.processing?.avgFirstResponseMinutes).toBeUndefined()
    expect(data.processingPending.value).toBe(true)
    expect(data.processingTimed.value).toBe(false)

    // Три выборки независимы и стартуют РАЗОМ: строки лидов, переходы, создания сразу в стадии.
    // Друг за другом месяц ждал бы вдвое дольше — и это проверяется, а не подразумевается.
    await vi.waitFor(() => expect(portal.pending[`leads:${AUGUST.from}`]).toBeDefined())
    expect(portal.pending[`history:${AUGUST.from}`]).toBeDefined()
    expect(portal.pending[`created:${AUGUST.from}`]).toBeDefined()
    portal.pending[`history:${AUGUST.from}`]!([
      { ID: '9', TYPE_ID: 2, OWNER_ID: '1', CREATED_TIME: '2026-08-10T10:30:00+03:00', STATUS_ID: '1' }
    ])
    // Второй запрос истории — создания сразу в стадии не-NEW: лид 3 заведён вручную уже «в
    // работе», ответ в момент создания. Отбрось композабл эту выборку — лид 3 стал бы просроченным.
    portal.pending[`created:${AUGUST.from}`]!([
      { ID: '10', TYPE_ID: 1, OWNER_ID: '3', CREATED_TIME: '2026-08-11T09:00:00+03:00', STATUS_ID: '1' }
    ])
    portal.pending[`leads:${AUGUST.from}`]!([
      { ID: '1', DATE_CREATE: '2026-08-10T10:00:00+03:00', SOURCE_ID: 'CALL', STATUS_ID: '1' },
      { ID: '2', DATE_CREATE: '2026-08-10T10:00:00+03:00', SOURCE_ID: 'CALL', STATUS_ID: 'NEW' },
      { ID: '3', DATE_CREATE: '2026-08-11T09:00:00+03:00', SOURCE_ID: 'WEB', STATUS_ID: '1' }
    ])
    await vi.waitFor(() => expect(data.processingPending.value).toBe(false))
    expect(data.processingTimed.value).toBe(true)
    const processing = data.report.value.processing!
    // Числа — от счётчиков, время — из истории: два ответа, 30 и 0 минут → 15 в среднем.
    expect(processing.processed).toBe(5)
    expect(processing.avgFirstResponseMinutes).toBeCloseTo(15, 6)
    expect(processing.bySource.map(r => r.sourceId).sort()).toEqual(['CALL', 'WEB'])
    // Лид 2 без ответа с 10 августа — просрочен по нормативу 120 минут; лид 3 — нет.
    expect(processing.overdue).toBe(1)
  })

  // ⚠ Смена периода посреди трёх выборок истории: их ответы обязаны пропасть, иначе под
  // сентябрьскими счётчиками окажется августовское время ответа — и флаг «история пришла».
  it('история за прошлый период после смены периода выбрасывается, следующая страница не запрашивается', async () => {
    const data = useReportData()
    const first = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await first
    await vi.waitFor(() => expect(portal.pending[`leads:${AUGUST.from}`]).toBeDefined())
    const leadCalls = portal.calls.filter(c => c === `leads:${AUGUST.from}`).length

    const second = data.load(SEPTEMBER)
    await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
    portal.pending[SEPTEMBER.from]!([])
    await second
    // Полная страница лидов августа приходит ПОСЛЕ смены периода: следующую страницу не просим.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({ ID: String(i + 1), DATE_CREATE: '2026-08-10T10:00:00+03:00', SOURCE_ID: 'CALL', STATUS_ID: '1' }))
    portal.pending[`leads:${AUGUST.from}`]!(fullPage)
    portal.pending[`history:${AUGUST.from}`]!([{ ID: '9', TYPE_ID: 2, OWNER_ID: '1', CREATED_TIME: '2026-08-10T10:30:00+03:00', STATUS_ID: '1' }])
    portal.pending[`created:${AUGUST.from}`]!([])
    await vi.waitFor(() => expect(portal.pending[`leads:${SEPTEMBER.from}`]).toBeDefined())
    expect(portal.calls.filter(c => c === `leads:${AUGUST.from}`).length).toBe(leadCalls)
    expect(data.dataset.value.period).toEqual(SEPTEMBER)
    expect(data.processingTimed.value).toBe(false)
    expect(data.report.value.processing?.avgFirstResponseMinutes).toBeUndefined()
    expect(data.processingPending.value).toBe(true)
  })

  it('история стадий: ошибка — своя, счётчики блока 6 на месте', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading
    await vi.waitFor(() => expect(portal.pending[`leads:${AUGUST.from}`]).toBeDefined())
    portal.pending[`leads:${AUGUST.from}`]!(new Error('история недоступна'))
    await vi.waitFor(() => expect(data.processingPending.value).toBe(false))
    expect(data.processingError.value).toContain('история недоступна')
    expect(data.report.value.processing).toMatchObject({ processed: 5, unprocessed: 2 })
  })

  // ⚠ Год — ≈ 1 300 страниц. Сама справка на таком периоде не стартует; стартует по кнопке —
  // и только для того периода, что на экране.
  it('на периоде длиннее квартала справка ждёт кнопки, по кнопке — стартует', async () => {
    const YEAR = { from: '2026-01-01', to: '2026-12-31' }
    const data = useReportData()
    const loading = data.load(YEAR)
    await vi.waitFor(() => expect(portal.pending[YEAR.from]).toBeDefined())
    portal.pending[YEAR.from]!([])
    await loading
    expect(data.unlinkedDeferred.value).toBe(true)
    expect(data.unlinkedPending.value).toBe(false)
    expect(data.processingDeferred.value).toBe(true)
    expect(portal.calls.some(c => c.startsWith('closed:') || c.startsWith('leads:'))).toBe(false)

    data.startUnlinked()
    expect(data.unlinkedDeferred.value).toBe(false)
    await vi.waitFor(() => expect(portal.pending[`closed:${YEAR.from}`]).toBeDefined())
    // Второе нажатие, пока идёт первое, — не вторая выборка с тем же курсором.
    data.startUnlinked()
    await Promise.resolve()
    expect(portal.calls.filter(c => c === `closed:${YEAR.from}`)).toHaveLength(1)
    portal.pending[`closed:${YEAR.from}`]!([])
    await vi.waitFor(() => expect(data.unlinkedPending.value).toBe(false))
    expect(data.dataset.value.unlinkedDeals?.total).toBe(0)
  })

  it('ошибка справки — своя ошибка, индикатор снят, основной отчёт цел', async () => {
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading
    await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
    portal.pending[`closed:${AUGUST.from}`]!(new Error('нет доступа'))
    await vi.waitFor(() => expect(data.unlinkedPending.value).toBe(false))
    expect(data.unlinkedError.value).toContain('нет доступа')
    expect(data.error.value).toBeUndefined()
    expect(data.isDemo.value).toBe(false)
    expect(data.dataset.value.unlinkedDeals).toBeUndefined()
  })

  // ⚠ Новая выборка упала до запуска своей справки, а справка прошлой ещё шла: без сброса
  // «Считаем…» от осиротевшей висело бы бесконечно под плашкой об ошибке.
  it('новая выборка снимает индикатор справки прошлого периода, даже если сама упала', async () => {
    const data = useReportData()
    const first = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await first
    await vi.waitFor(() => expect(data.unlinkedPending.value).toBe(true))

    const second = data.load(SEPTEMBER)
    await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
    portal.pending[SEPTEMBER.from]!(new Error('портал недоступен'))
    await second
    expect(data.error.value).toContain('портал недоступен')
    expect(data.unlinkedPending.value).toBe(false)
  })

  // ⚠ Подсказка читала конверт ответа вместо строк и не срабатывала НИКОГДА — на пустом периоде
  // экран уверял, что в портале нет ни одного лида и стоит проверить доступ к CRM.
  it('на пустом периоде узнаёт дату последнего лида', async () => {
    portal.leadTotal = 0
    const data = useReportData()
    const loading = data.load(AUGUST)
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
    portal.pending[AUGUST.from]!([])
    await loading
    expect(data.latestLeadDate.value).toBe('2026-08-17')
  })

  // ⚠ Тот самый сценарий: август спросили первым, но ответил он последним.
  it('устаревший ответ не затирает более новый период', async () => {
    const data = useReportData()
    const first = data.load(AUGUST)
    const second = data.load(SEPTEMBER)
    await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
    await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())

    portal.pending[SEPTEMBER.from]!([])
    await second
    expect(data.dataset.value.period).toEqual(SEPTEMBER)

    portal.pending[AUGUST.from]!([])
    await first
    expect(data.dataset.value.period).toEqual(SEPTEMBER)
    // Индикатор гасит только СВОЙ запрос — устаревший не должен снимать его с более нового.
    expect(data.pending.value).toBe(false)
  })

  /**
   * Фильтры (ТЗ от 2026-09-04). Портал получает их в запросах, и это единственное, что можно
   * проверить: счётчики и строки приходят уже отфильтрованными, ядро о фильтрах не знает.
   */
  describe('фильтры', () => {
    it('источник — в каждый счётчик лидов, в сделки и в строки лидов для истории; контекст всех сделок не спрашивается', async () => {
      const data = useReportData()
      const loading = data.load(AUGUST, { sourceId: 'CALL' })
      await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
      expect(portal.filters[AUGUST.from]).toMatchObject({ 'SOURCE_ID': 'CALL', '!LEAD_ID': null })
      portal.pending[AUGUST.from]!([])
      await loading
      expect(data.filters.value).toEqual({ sourceId: 'CALL' })
      for (const [key, filter] of Object.entries(portal.batchFilters)) expect(filter, key).toMatchObject({ SOURCE_ID: 'CALL' })
      // Свой источник спрошен под фильтром, чужой — не спрошен вовсе, стадии — под фильтром.
      expect(portal.batchFilters).toHaveProperty(leadCountKey.source('CALL'))
      expect(portal.batchFilters).not.toHaveProperty(leadCountKey.source('EMAIL'))
      expect(portal.batchFilters[leadCountKey.stage('1')]).toMatchObject({ SOURCE_ID: 'CALL', STATUS_ID: '1' })
      // «Успешных из всех» под фильтром сравнивало бы отфильтрованное с полным — контекста нет.
      expect(data.dataset.value.allDeals).toBeUndefined()
      await vi.waitFor(() => expect(portal.pending[`leads:${AUGUST.from}`]).toBeDefined())
      expect(portal.filters[`leads:${AUGUST.from}`]).toMatchObject({ SOURCE_ID: 'CALL' })
    })

    // ⚠ У сделки нет менеджера лида: фильтр ложится на сделки через список ID лидов. Лидов нет —
    // сделок нет, и портал об этом не спрашивают: `LEAD_ID: [0]` отдал бы сделки БЕЗ лида.
    it('менеджер — сначала ID лидов под фильтром, потом сделки по списку; без лидов сделок не спрашивают', async () => {
      const data = useReportData()
      const loading = data.load(AUGUST, { assignedById: 562 })
      await vi.waitFor(() => expect(portal.pending[`ids:${AUGUST.from}`]).toBeDefined())
      expect(portal.filters[`ids:${AUGUST.from}`]).toMatchObject({ ASSIGNED_BY_ID: 562 })
      portal.pending[`ids:${AUGUST.from}`]!([{ ID: '1' }, { ID: '2' }])
      await vi.waitFor(() => expect(portal.pending['deals-by:1,2']).toBeDefined())
      expect(portal.filters['deals-by:1,2']).not.toHaveProperty('!LEAD_ID')
      portal.pending['deals-by:1,2']!([{ ID: '10', LEAD_ID: '1', STAGE_ID: 'WON', OPPORTUNITY: '300', CURRENCY_ID: 'BYN', SOURCE_ID: 'CALL', DATE_CREATE: '2026-08-10T10:00:00+03:00', ASSIGNED_BY_ID: '562' }])
      // Источник ЛИДА спрашивается и под фильтром: разрез не должен зависеть от того, отбирали
      // ли что-то на экране.
      await vi.waitFor(() => expect(portal.pending[`lead-sources:${AUGUST.from}`]).toBeDefined())
      portal.pending[`lead-sources:${AUGUST.from}`]!([{ ID: '1', SOURCE_ID: 'CALL' }])
      await loading
      expect(data.dataset.value.deals).toHaveLength(1)
      // Список ID остаётся в наборе — по нему детализация строит сделки «тем же фильтром».
      expect(data.dataset.value.filteredLeadIds).toEqual([1, 2])

      // Строки лидов для истории стадий — под тем же фильтром.
      await vi.waitFor(() => expect(portal.pending[`leads:${AUGUST.from}`]).toBeDefined())
      expect(portal.filters[`leads:${AUGUST.from}`]).toMatchObject({ ASSIGNED_BY_ID: 562 })

      const second = data.load(SEPTEMBER, { assignedById: 562 })
      await vi.waitFor(() => expect(portal.pending[`ids:${SEPTEMBER.from}`]).toBeDefined())
      portal.pending[`ids:${SEPTEMBER.from}`]!([])
      await second
      expect(data.dataset.value.deals).toEqual([])
      expect(portal.calls.filter(c => c.startsWith('deals-by:'))).toEqual(['deals-by:1,2'])
    })

    // ⚠ `{ ...base, STATUS_ID: 'NEW' }` при фильтре по стадии брака заменял бы условие фильтра:
    // блок 6 показывал бы «не обработано 100 %» для лидов, которые по фильтру давно закрыты.
    it('причина закрытия лида: «не обработано» и чужие причины не спрашиваются, обработано — все', async () => {
      const data = useReportData()
      const loading = data.load(AUGUST, { junkReasonId: 'JUNK' })
      await vi.waitFor(() => expect(portal.pending[`ids:${AUGUST.from}`]).toBeDefined())
      portal.pending[`ids:${AUGUST.from}`]!([])
      await loading
      expect(portal.batchFilters).toHaveProperty(leadCountKey.junkReason('JUNK'))
      expect(portal.batchFilters).not.toHaveProperty(leadCountKey.junkReason('OTHER'))
      expect(portal.batchFilters).not.toHaveProperty(leadCountKey.unprocessed)
      expect(portal.batchFilters).not.toHaveProperty(leadCountKey.stage('1'))
      expect(data.report.value.processing).toMatchObject({ processed: 7, unprocessed: 0 })
      // Причины брака в словаре — только стадии провала: фильтр по ним строится из словаря.
      expect(Object.keys(data.dataset.value.dictionaries.junkReasons).sort()).toEqual(['JUNK', 'OTHER'])
    })

    // ⚠ Применённые фильтры — только вместе с данными: обогнавшая выборка с фильтром побеждает,
    // а опоздавший ответ без фильтра не возвращает панели «нет фильтров» над отфильтрованными числами.
    it('смена только фильтра: опоздавший ответ прошлой выборки того же периода выбрасывается', async () => {
      const data = useReportData()
      const first = data.load(AUGUST)
      await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
      const second = data.load(AUGUST, { assignedById: 562 })
      await vi.waitFor(() => expect(portal.pending[`ids:${AUGUST.from}`]).toBeDefined())
      portal.pending[`ids:${AUGUST.from}`]!([{ ID: '1' }])
      await vi.waitFor(() => expect(portal.pending['deals-by:1']).toBeDefined())
      portal.pending['deals-by:1']!([])
      await second
      expect(data.filters.value).toEqual({ assignedById: 562 })
      portal.pending[AUGUST.from]!([{ ID: '10', LEAD_ID: '1', STAGE_ID: 'WON', OPPORTUNITY: '300', CURRENCY_ID: 'BYN', SOURCE_ID: 'CALL', DATE_CREATE: '2026-08-10T10:00:00+03:00' }])
      await first
      expect(data.filters.value).toEqual({ assignedById: 562 })
      expect(data.dataset.value.deals).toEqual([])
      expect(data.pending.value).toBe(false)
    })

    // Блок 7 и история стадий от фильтров не зависят: при том же периоде они остаются, а не
    // уходят в новую минутную выборку на каждый клик по фильтру.
    it('смена только фильтра не перечитывает справку блока 7 и историю стадий', async () => {
      const data = useReportData()
      const first = data.load(AUGUST)
      await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
      portal.pending[AUGUST.from]!([])
      await first
      await vi.waitFor(() => expect(portal.pending[`closed:${AUGUST.from}`]).toBeDefined())
      portal.pending[`closed:${AUGUST.from}`]!([{ ID: '1', SOURCE_ID: '', OPPORTUNITY: '500', CURRENCY_ID: 'BYN' }])
      await vi.waitFor(() => expect(data.dataset.value.unlinkedDeals?.total).toBe(1))
      await vi.waitFor(() => expect(portal.pending[`history:${AUGUST.from}`]).toBeDefined())
      portal.pending[`history:${AUGUST.from}`]!([{ ID: '9', TYPE_ID: 2, OWNER_ID: '1', CREATED_TIME: '2026-08-10T10:30:00+03:00', STATUS_ID: '1' }])
      portal.pending[`created:${AUGUST.from}`]!([])
      portal.pending[`leads:${AUGUST.from}`]!([{ ID: '1', DATE_CREATE: '2026-08-10T10:00:00+03:00', SOURCE_ID: 'CALL', STATUS_ID: '1' }])
      await vi.waitFor(() => expect(data.processingTimed.value).toBe(true))
      const closedCalls = portal.calls.filter(c => c === `closed:${AUGUST.from}`).length
      const historyCalls = portal.calls.filter(c => c.startsWith('history:')).length

      const second = data.load(AUGUST, { sourceId: 'CALL' })
      await vi.waitFor(() => expect(portal.filters[AUGUST.from]).toMatchObject({ SOURCE_ID: 'CALL' }))
      portal.pending[AUGUST.from]!([])
      await second
      // Справка на месте и не перезапрошена; история — из памяти, заново только строки лидов.
      expect(data.dataset.value.unlinkedDeals?.total).toBe(1)
      expect(data.unlinkedPending.value).toBe(false)
      expect(portal.calls.filter(c => c === `closed:${AUGUST.from}`).length).toBe(closedCalls)
      await vi.waitFor(() => expect(portal.calls.filter(c => c === `leads:${AUGUST.from}`).length).toBe(2))
      expect(portal.calls.filter(c => c.startsWith('history:')).length).toBe(historyCalls)
      portal.pending[`leads:${AUGUST.from}`]!([{ ID: '1', DATE_CREATE: '2026-08-10T10:00:00+03:00', SOURCE_ID: 'CALL', STATUS_ID: '1' }])
      await vi.waitFor(() => expect(data.processingTimed.value).toBe(true))
      expect(data.report.value.processing?.avgFirstResponseMinutes).toBeCloseTo(30, 6)

      // Другой период — справка и история заново.
      const third = data.load(SEPTEMBER, { sourceId: 'CALL' })
      await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
      portal.pending[SEPTEMBER.from]!([])
      await third
      expect(data.dataset.value.unlinkedDeals).toBeUndefined()
      await vi.waitFor(() => expect(portal.pending[`closed:${SEPTEMBER.from}`]).toBeDefined())
      await vi.waitFor(() => expect(portal.pending[`history:${SEPTEMBER.from}`]).toBeDefined())
    })

    it('причина проигрыша — сделки ждут справочник стадий; без кодов под названием — заведомо пустая выборка', async () => {
      const data = useReportData()
      const loading = data.load(AUGUST, { lossReasonKey: 'дорого' })
      await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
      // Название без кодов уходит как код стадии — такой стадии нет, выборка пуста.
      expect(portal.filters[AUGUST.from]).toMatchObject({ STAGE_ID: ['дорого'] })
      portal.pending[AUGUST.from]!([])
      await loading
      expect(data.dataset.value.deals).toEqual([])
    })

    it('сотрудники читаются ПОЛНОСТЬЮ, один раз на открытие; в словаре «Фамилия Имя»', async () => {
      portal.users = Array.from({ length: 60 }, (_, i) => ({ ID: String(i + 1), NAME: 'Имя', LAST_NAME: `Фамилия${i + 1}` }))
      const data = useReportData()
      const first = data.load(AUGUST)
      await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
      portal.pending[AUGUST.from]!([])
      await first
      // ⚠ Шестьдесят, а не пятьдесят. Ровно это и ломалось на боевом: самодельное листание
      // читало `next` из `getData()`, где его нет вовсе, и обрывалось после первой страницы —
      // сотрудники с 51-го шли в отчёте под подписью «Сотрудник #N».
      expect(Object.keys(data.dataset.value.dictionaries.users ?? {})).toHaveLength(60)
      expect(data.dataset.value.dictionaries.users?.['60']).toBe('Фамилия60 Имя')
      // Два прохода — активные и уволенные. Страницы внутри каждого листает SDK, не мы.
      expect(portal.calls.filter(c => c === 'user.get')).toHaveLength(2)
      // ⚠ И ни одного одиночного `user.get`: ручное листание сюда вернуться не должно.
      expect(portal.calls.filter(c => c === 'user.get:одиночный')).toHaveLength(0)

      const second = data.load(SEPTEMBER)
      await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
      portal.pending[SEPTEMBER.from]!([])
      await second
      // Второе открытие берёт сотрудников из памяти: за минуту они не меняются.
      expect(portal.calls.filter(c => c === 'user.get')).toHaveLength(2)
    })

    /**
     * ⚠ Уволенные в словаре ЕСТЬ, и это не мелочь оформления: их лиды никуда не делись, а портал
     * по умолчанию отдаёт только работающих. Без второго прохода лид уволившегося подписан
     * «Сотрудник #562» — число верное, а чьё оно, непонятно.
     */
    it('уволенные попадают в словарь имён вторым проходом', async () => {
      portal.users = [{ ID: '1', NAME: 'Иван', LAST_NAME: 'Иванов' }]
      portal.dismissedUsers = [{ ID: '562', NAME: 'Анна', LAST_NAME: 'Авдеева', ACTIVE: false }]
      const data = useReportData()
      const load = data.load(AUGUST)
      await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
      portal.pending[AUGUST.from]!([])
      await load
      expect(data.dataset.value.dictionaries.users).toEqual({ 1: 'Иванов Иван', 562: 'Авдеева Анна' })
    })

    it('user.get упал — словарь пуст, отчёт цел, следующая выборка спрашивает снова', async () => {
      portal.usersFail = true
      const data = useReportData()
      const first = data.load(AUGUST)
      await vi.waitFor(() => expect(portal.pending[AUGUST.from]).toBeDefined())
      portal.pending[AUGUST.from]!([])
      await first
      expect(data.error.value).toBeUndefined()
      expect(data.isDemo.value).toBe(false)
      expect(data.dataset.value.dictionaries.users ?? {}).toEqual({})

      portal.usersFail = false
      portal.users = [{ ID: '562', NAME: 'Анна', LAST_NAME: 'Иванова' }]
      const second = data.load(SEPTEMBER)
      await vi.waitFor(() => expect(portal.pending[SEPTEMBER.from]).toBeDefined())
      portal.pending[SEPTEMBER.from]!([])
      await second
      expect(data.dataset.value.dictionaries.users).toEqual({ 562: 'Иванова Анна' })
      // Первая выборка упала на первом же проходе (1 вызов), вторая прошла оба (ещё 2).
      expect(portal.calls.filter(c => c === 'user.get')).toHaveLength(3)
    })

    it('вне портала демо-набор фильтруется по строкам — сводка меньше полной', async () => {
      portal.initialized = false
      const data = useReportData()
      await data.load(AUGUST)
      const full = data.report.value.summary.totalLeads
      const [sourceId] = Object.keys(data.dataset.value.dictionaries.sources)
      await data.load(AUGUST, { sourceId })
      expect(data.filters.value).toEqual({ sourceId })
      expect(data.report.value.summary.totalLeads).toBeGreaterThan(0)
      expect(data.report.value.summary.totalLeads).toBeLessThan(full)
      expect(portal.calls).toEqual([])
    })
  })
})
