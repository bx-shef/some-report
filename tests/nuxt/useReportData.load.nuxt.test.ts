// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useReportData } from '~/composables/useReportData'

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
  calls: [] as string[]
}))

/** Пустой, но исправный ответ пакета: у каждой команды `getTotal()` и `getData()`. */
function batchAnswer(commands: Record<string, unknown>) {
  const data: Record<string, { getTotal: () => number, getData: () => { result: unknown[] } }> = {}
  for (const key of Object.keys(commands)) {
    data[key] = { getTotal: () => (key === 'total' ? portal.leadTotal : key === 'unprocessed' ? Math.min(2, portal.leadTotal) : 0), getData: () => ({ result: [] }) }
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
            const key = method === 'crm.deal.list'
              ? `closed:${params.filter?.['>=CLOSEDATE'] ?? '?'}`
              : history
                ? `${(params.filter as { TYPE_ID?: unknown })?.TYPE_ID === 1 ? 'created' : 'history'}:${params.filter?.['>=CREATED_TIME'] ?? '?'}`
                : cursor && method === 'crm.lead.list' ? `leads:${params.filter?.['>=DATE_CREATE'] ?? '?'}` : undefined
            if (key) {
              portal.calls.push(key)
              return new Promise((resolve) => {
                portal.pending[key] = rows => resolve(rows instanceof Error
                  ? { isSuccess: false, getData: () => undefined, getErrorMessages: () => [rows.message] }
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
          make: ({ params }: { params: { filter: Record<string, string> } }) => {
            const from = params.filter['>=DATE_CREATE'] ?? '?'
            portal.calls.push(from)
            return new Promise((resolve) => {
              portal.pending[from] = rows => resolve(rows instanceof Error
                ? { isSuccess: false, getData: () => undefined, getErrorMessages: () => [rows.message] }
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
  portal.calls = []
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
})
