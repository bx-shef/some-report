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
  /** Отложенные ответы постраничной выборки по периоду: тест сам решает, кто ответит первым. */
  pending: {} as Record<string, (rows: unknown[]) => void>,
  calls: [] as string[]
}))

/** Пустой, но исправный ответ пакета: у каждой команды `getTotal()` и `getData()`. */
function batchAnswer(commands: Record<string, unknown>) {
  const data: Record<string, { getTotal: () => number, getData: () => { result: unknown[] } }> = {}
  for (const key of Object.keys(commands)) {
    data[key] = { getTotal: () => (key === 'total' ? 7 : 0), getData: () => ({ result: [] }) }
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
        call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { categories: [] } }) }) },
        callList: {
          make: ({ params }: { params: { filter: Record<string, string> } }) => {
            const from = params.filter['>=DATE_CREATE'] ?? '?'
            portal.calls.push(from)
            return new Promise((resolve) => {
              portal.pending[from] = rows => resolve({ isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
            })
          }
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.initialized = true
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
