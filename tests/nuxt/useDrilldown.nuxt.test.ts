// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useDrilldown } from '~/composables/useDrilldown'
import type { ReportDataset, ReportFilters } from '~/types/report'
import { drill } from '~/utils/drilldown'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Листание списка детализации: курсор по ID, куски по 500 под фильтром по лиду, устаревшие
 * ответы после закрытия. Число над списком считает портал — здесь важно, чтобы список шёл по
 * тому же условию и не пропускал страниц.
 */
const portal = vi.hoisted(() => ({
  calls: [] as Array<{ method: string, filter: Record<string, unknown> }>,
  pending: [] as Array<(rows: unknown[] | Error) => void>,
  opened: [] as string[]
}))

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => true,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  openPath: async (path: string) => {
    if (path) portal.opened.push(path)
    return Boolean(path)
  },
  getOrThrow: () => ({
    actions: {
      v2: {
        call: {
          make: ({ method, params }: { method: string, params: { filter: Record<string, unknown> } }) => {
            portal.calls.push({ method, filter: params.filter })
            return new Promise((resolve) => {
              portal.pending.push(rows => resolve(rows instanceof Error
                ? { isSuccess: false, getData: () => undefined, getErrorMessages: () => [rows.message] }
                : { isSuccess: true, getData: () => ({ result: rows }), getErrorMessages: () => [] }))
            })
          }
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.calls = []
  portal.pending = []
  portal.opened = []
})

const AUGUST = { from: '2026-08-01', to: '2026-08-31' }

function live(extra: Partial<ReportDataset> = {}, filters: ReportFilters = {}) {
  const mock = buildMockDataset()
  const dataset = ref<ReportDataset>({ ...mock, leads: [], deals: [], period: AUGUST, dictionaries: { ...mock.dictionaries, users: { 562: 'Иванова Анна' } }, ...extra })
  return useDrilldown({ dataset, filters: ref(filters), isDemo: ref(false) })
}

const leadRows = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ ID: String(from + i), TITLE: `Лид ${from + i}`, DATE_CREATE: '2026-08-10T10:00:00+03:00', STATUS_ID: 'JUNK', SOURCE_ID: 'CALL', ASSIGNED_BY_ID: '562' }))

describe('useDrilldown', () => {
  it('портал: первая страница сразу, дальше по курсору ID, короткая страница — конец', async () => {
    const d = live()
    d.show(drill.junk())
    expect(d.open.value).toBe(true)
    expect(d.request.value?.title).toBe('Брак лидов')
    await vi.waitFor(() => expect(portal.calls).toHaveLength(1))
    expect(portal.calls[0]).toMatchObject({ method: 'crm.lead.list', filter: { 'STATUS_SEMANTIC_ID': 'F', '>ID': 0, '>=DATE_CREATE': '2026-08-01' } })
    expect(d.pending.value).toBe(true)
    portal.pending[0]!(leadRows(1, 50))
    await vi.waitFor(() => expect(d.rows.value).toHaveLength(50))
    expect(d.done.value).toBe(false)
    expect(d.rows.value[0]).toMatchObject({ id: 1, title: 'Лид 1', manager: 'Иванова Анна', path: '/crm/lead/details/1/' })

    // Страница приходит ПОСЛЕ запроса — вызов не ждём, иначе тест ждал бы сам себя.
    void d.loadMore()
    await vi.waitFor(() => expect(portal.calls).toHaveLength(2))
    expect(portal.calls[1]!.filter).toMatchObject({ '>ID': 50 })
    portal.pending[1]!(leadRows(51, 10))
    await vi.waitFor(() => expect(d.done.value).toBe(true))
    expect(d.rows.value).toHaveLength(60)
    // Конец списка — следующей страницы не просим.
    void d.loadMore()
    await Promise.resolve()
    expect(portal.calls).toHaveLength(2)
  })

  // ⚠ Под фильтром по менеджеру сделки — по списку ID лидов из набора, кусками по 500: курсор
  // внутри куска, кусок исчерпан — следующий. Без списка — сделок нет, и портал не спрашивают.
  it('сделки под фильтром по менеджеру — по кускам ID лидов из набора', async () => {
    const leadIds = Array.from({ length: 600 }, (_, i) => i + 1)
    const d = live({ filteredLeadIds: leadIds }, { assignedById: 562 })
    d.show(drill.wonDeals())
    await vi.waitFor(() => expect(portal.calls).toHaveLength(1))
    expect(portal.calls[0]!.method).toBe('crm.deal.list')
    expect(portal.calls[0]!.filter.LEAD_ID).toEqual(leadIds.slice(0, 500))
    expect(portal.calls[0]!.filter).not.toHaveProperty('!LEAD_ID')
    expect(portal.calls[0]!.filter).toMatchObject({ 'STAGE_SEMANTIC_ID': 'S', '>ID': 0 })
    portal.pending[0]!([{ ID: '10', TITLE: 'Сделка', DATE_CREATE: '2026-08-01', STAGE_ID: 'WON', OPPORTUNITY: '300', CURRENCY_ID: 'BYN' }])
    await vi.waitFor(() => expect(d.rows.value).toHaveLength(1))
    expect(d.done.value).toBe(false)
    void d.loadMore()
    await vi.waitFor(() => expect(portal.calls).toHaveLength(2))
    expect(portal.calls[1]!.filter.LEAD_ID).toEqual(leadIds.slice(500))
    expect(portal.calls[1]!.filter).toMatchObject({ '>ID': 0 })
    portal.pending[1]!([])
    await vi.waitFor(() => expect(d.done.value).toBe(true))
    expect(d.rows.value[0]).toMatchObject({ amount: 300, currencyId: 'BYN', path: '/crm/deal/details/10/' })

    const empty = live({ filteredLeadIds: [] }, { assignedById: 562 })
    empty.show(drill.wonDeals())
    await Promise.resolve()
    expect(empty.done.value).toBe(true)
    expect(portal.calls).toHaveLength(2)
  })

  // Кусок дал короткую страницу — следующий кусок в том же вызове, иначе «Показать ещё» отдавало
  // бы пустоту по клику на кусок, а наблюдатель за концом списка молчал бы.
  it('короткая страница куска — следующий кусок сразу, пока не наберётся страница или куски не кончатся', async () => {
    const leadIds = Array.from({ length: 1200 }, (_, i) => i + 1)
    const d = live({ filteredLeadIds: leadIds }, { assignedById: 562 })
    d.show(drill.wonDeals())
    await vi.waitFor(() => expect(portal.calls).toHaveLength(1))
    portal.pending[0]!([{ ID: '1', TITLE: 'a', STAGE_ID: 'WON' }])
    await vi.waitFor(() => expect(portal.calls).toHaveLength(2))
    expect(portal.calls[1]!.filter.LEAD_ID).toEqual(leadIds.slice(500, 1000))
    expect(d.pending.value).toBe(true)
    portal.pending[1]!([])
    await vi.waitFor(() => expect(portal.calls).toHaveLength(3))
    portal.pending[2]!([{ ID: '7', TITLE: 'b', STAGE_ID: 'WON' }])
    await vi.waitFor(() => expect(d.done.value).toBe(true))
    expect(d.rows.value.map(r => r.id)).toEqual([1, 7])
    expect(d.pending.value).toBe(false)
  })

  it('условие числа спорит с фильтром — список пуст без запроса', async () => {
    const d = live({}, { junkReasonId: 'JUNK' })
    d.show(drill.unprocessed())
    await Promise.resolve()
    expect(d.done.value).toBe(true)
    expect(d.rows.value).toEqual([])
    expect(portal.calls).toEqual([])
  })

  it('закрыли или открыли другое число — опоздавшая страница выбрасывается', async () => {
    const d = live()
    d.show(drill.leads())
    await vi.waitFor(() => expect(portal.calls).toHaveLength(1))
    d.open.value = false
    await nextTick()
    portal.pending[0]!(leadRows(1, 50))
    await Promise.resolve()
    await Promise.resolve()
    expect(d.rows.value).toEqual([])

    d.show(drill.junk())
    await vi.waitFor(() => expect(portal.calls).toHaveLength(2))
    d.show(drill.qualified())
    await vi.waitFor(() => expect(portal.calls).toHaveLength(3))
    portal.pending[1]!(leadRows(1, 5))
    portal.pending[2]!(leadRows(100, 2))
    await vi.waitFor(() => expect(d.done.value).toBe(true))
    expect(d.rows.value.map(r => r.id)).toEqual([100, 101])
    expect(d.request.value?.title).toBe('Квалифицировано в сделку')
  })

  it('ошибка страницы — своя, список остаётся тем, что уже прочитан; повтор — с чистой плашкой', async () => {
    const d = live()
    d.show(drill.leads())
    await vi.waitFor(() => expect(portal.calls).toHaveLength(1))
    portal.pending[0]!(new Error('нет доступа'))
    await vi.waitFor(() => expect(d.error.value).toContain('нет доступа'))
    expect(d.pending.value).toBe(false)
    expect(d.done.value).toBe(false)
    void d.loadMore()
    await vi.waitFor(() => expect(portal.calls).toHaveLength(2))
    expect(d.error.value).toBeUndefined()
    portal.pending[1]!(leadRows(1, 3))
    await vi.waitFor(() => expect(d.done.value).toBe(true))
    expect(d.rows.value).toHaveLength(3)
  })

  // Закрытие посреди страницы оставляло бы «читаем…» навсегда — новый список не стартовал бы.
  it('повторный show сбрасывает «читаем…» от отброшенной страницы; закрытие очищает строки', async () => {
    const d = live()
    d.show(drill.leads())
    await vi.waitFor(() => expect(portal.calls).toHaveLength(1))
    portal.pending[0]!(leadRows(1, 50))
    await vi.waitFor(() => expect(d.rows.value).toHaveLength(50))
    d.open.value = false
    await nextTick()
    expect(d.rows.value).toEqual([])
    d.show(drill.junk())
    expect(d.pending.value).toBe(true)
    await vi.waitFor(() => expect(portal.calls).toHaveLength(2))
  })

  it('отказ портала открыть карточку — плашка в слайдере', async () => {
    const d = live()
    expect(await d.openRow({ id: 1, title: 'x', path: '/crm/lead/details/1/' })).toBe(true)
    expect(d.error.value).toBeUndefined()
    expect(await d.openRow({ id: 2, title: 'y', path: '' })).toBe(false)
  })

  it('демо-набор: список из строк, целиком, без запросов; карточек нет', async () => {
    const dataset = ref(buildMockDataset())
    const d = useDrilldown({ dataset, filters: ref({}), isDemo: ref(true) })
    d.show(drill.junk())
    expect(d.done.value).toBe(true)
    expect(d.rows.value.length).toBeGreaterThan(0)
    expect(d.rows.value[0]!.path).toBe('')
    expect(portal.calls).toEqual([])
    expect(await d.openRow(d.rows.value[0]!)).toBe(false)
    expect(await d.openRow({ id: 1, title: 'x', path: '/crm/lead/details/1/' })).toBe(true)
    expect(portal.opened).toEqual(['/crm/lead/details/1/'])
  })
})
