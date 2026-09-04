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
    data[key] = { getTotal: () => (key === 'total' ? portal.leadTotal : 0), getData: () => ({ result: [] }) }
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
            if (method === 'crm.deal.list') {
              const key = `closed:${params.filter?.['>=CLOSEDATE'] ?? '?'}`
              portal.calls.push(key)
              return new Promise((resolve) => {
                portal.pending[key] = rows => resolve(rows instanceof Error
                  ? { isSuccess: false, getData: () => undefined, getErrorMessages: () => [rows.message] }
                  : { isSuccess: true, getData: () => ({ result: rows }), getErrorMessages: () => [] })
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
