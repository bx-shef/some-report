// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useManagerDrilldown } from '~/composables/useManagerDrilldown'
import type { ManagerFilters } from '~/types/managers'
import type { ReportDictionaries } from '~/types/report'

/**
 * Список сделок за числом матрицы: тем же условием, страницами, со ссылками в CRM.
 *
 * ⚠ Главное здесь — фильтр запроса. Список, собранный не тем условием, что дало число, хуже
 * отсутствия списка: он выглядит как ответ и им не является.
 */
const portal = vi.hoisted(() => ({
  calls: [] as Array<{ method: string, filter: Record<string, unknown> }>,
  pending: [] as Array<(rows: unknown[] | Error) => void>,
  opened: [] as string[],
  /** Портал не открывает карточку: слайдер обязан сказать об этом, а не промолчать. */
  openFails: false,
  /** Страницы, открытые НАСТОЯЩИМ слайдером портала, — с параметрами вызова. */
  sliderPages: [] as Array<Record<string, unknown>>,
  /** Слайдер отказал (мобильное приложение): панель внутри отчёта обязана подхватить. */
  sliderFails: false
}))

// Настоящий слайдер портала — тот же стенд, что и у `useB24`: страница детализации живёт в
// отдельном фрейме, и композабл лишь просит портал его открыть.
mockNuxtImport('usePortalSlider', () => () => ({
  // ⚠ Асинхронный, как и настоящий: перед открытием слайдера условие ПИШЕТСЯ в `user.option`, и
  // запись ждут. Сторож `stillWanted` спрашивается между записью и открытием — вытесненный клик
  // портал беспокоить не должен.
  openDrill: async (payload: { title: string, filter: Record<string, unknown> }, stillWanted: () => boolean = () => true) => {
    if (portal.sliderFails) return false
    if (!stillWanted()) return true
    portal.sliderPages.push({ place: 'app-drill', ...payload })
    return true
  },
  readDrill: async () => ({ ok: false as const, reason: 'не детализация' }),
  drillRequested: () => false
}))

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => true,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  openPath: async (path: string) => {
    if (portal.openFails) return false
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
  portal.openFails = false
  portal.sliderPages = []
  portal.sliderFails = false
})

const DICTIONARIES: ReportDictionaries = {
  sources: { CALL: 'Звонок' },
  junkReasons: {},
  lossReasons: {},
  dealStages: { NEW: 'Новая' },
  users: { 1: 'Иванов Иван' }
}

const FILTERS: ManagerFilters = { categoryId: 0, scope: 'in-work', period: { from: '2026-09-01', to: '2026-09-30' } }

function live() {
  return useManagerDrilldown({ filters: ref(FILTERS), dictionaries: ref(DICTIONARIES) })
}

/**
 * Тот же композабл, но с ОТКАЗАВШИМ слайдером — то есть на запасном пути.
 *
 * ⚠ Списком, страницами и ошибками занимается именно он: в обычном случае строки читает уже
 * открытая страница слайдера (`useDrillPage`), и здешний композабл портал ни о чём не спрашивает.
 * Панель при этом не мёртвый код — она поднимается там, где слайдера нет (мобильное приложение).
 */
function panel() {
  portal.sliderFails = true
  return live()
}

/** Ответ портала страницей записей. */
function answer(count: number, from = 1) {
  const rows = Array.from({ length: count }, (_, index) => ({
    ID: String(from + index),
    TITLE: `Сделка ${from + index}`,
    DATE_CREATE: '2026-09-01',
    STAGE_ID: 'NEW',
    SOURCE_ID: 'CALL',
    ASSIGNED_BY_ID: '1',
    OPPORTUNITY: '100',
    CURRENCY_ID: 'BYN'
  }))
  portal.pending.shift()?.(rows)
}

describe('useManagerDrilldown', () => {
  it('спрашивает портал ровно условием клетки', async () => {
    const drill = panel()
    const base = { CATEGORY_ID: 0, STAGE_SEMANTIC_ID: 'P' }
    drill.show(drill.cellRequest('Сделки: Минск · Иванов Иван · Новая', base, { companyId: 10, managerId: 1, stageId: 'NEW' }, 4))
    await nextTick()
    expect(portal.calls[0]!.method).toBe('crm.deal.list')
    expect(portal.calls[0]!.filter).toEqual({
      'CATEGORY_ID': 0,
      'STAGE_SEMANTIC_ID': 'P',
      'MYCOMPANY_ID': 10,
      'ASSIGNED_BY_ID': 1,
      'STAGE_ID': 'NEW',
      '>ID': 0
    })
  })

  it('строки подписаны словами: стадия и ответственный — из справочников', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Сделки', {}, { companyId: 10 }, 2))
    await nextTick()
    answer(2)
    await nextTick()
    expect(drill.rows.value[0]).toMatchObject({ title: 'Сделка 1', stage: 'Новая', manager: 'Иванов Иван', source: 'Звонок' })
    expect(drill.rows.value[0]!.path).toBe('/crm/deal/details/1/')
  })

  it('короткая страница закрывает список, полная — оставляет курсор', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Сделки', {}, { companyId: 10 }, 60))
    await nextTick()
    answer(50)
    await nextTick()
    expect(drill.done.value).toBe(false)
    void drill.loadMore()
    await nextTick()
    // Курсор — по последнему прочитанному ID, а не по номеру страницы.
    expect(portal.calls[1]!.filter['>ID']).toBe(50)
    answer(5, 51)
    await nextTick()
    expect(drill.done.value).toBe(true)
    expect(drill.rows.value).toHaveLength(55)
  })

  it('закрытие панели выбрасывает страницу, которая ещё шла', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Сделки', {}, { companyId: 10 }, 4))
    // ⚠ Панель поднимается ПОСЛЕ отказа слайдера, а отказ приходит через await: условие уезжает
    // в слайдер записью в `user.option`, и её ждут. Отсюда такты ожидания.
    await vi.waitFor(() => expect(drill.open.value).toBe(true))
    drill.open.value = false
    await nextTick()
    answer(3)
    await nextTick()
    expect(drill.rows.value).toHaveLength(0)
  })

  /**
   * ⚠ Демо-набора у детализации больше НЕТ (решение владельца от 2026-09-06): вне портала список
   * не работает совсем, и числа там не кликабельны. Здесь проверяем главное новое свойство:
   * список открывает НАСТОЯЩИЙ слайдер портала, а панель внутри отчёта не поднимается вовсе.
   */
  it('список открывает настоящий слайдер портала, а не панель внутри отчёта', async () => {
    const drill = live()
    drill.show(drill.cellRequest('Сделки: Минск', { CATEGORY_ID: 0 }, { companyId: 10, managerId: 101 }, 4))
    await nextTick()
    await nextTick()
    expect(portal.sliderPages).toHaveLength(1)
    const sent = portal.sliderPages[0]!
    // ⚠ Сверяем нагрузку ЦЕЛИКОМ, а не только `place`. Условие клетки едет в отдельный фрейм, где
    // состояния отчёта нет вовсе: потеряй тут `categoryId` — и список подписал бы стадии словами
    // чужого направления; потеряй `dealScope` — взял бы не ту дату; потеряй `total` — не сказал бы
    // «показано M из N».
    expect(sent).toMatchObject({ place: 'app-drill', entity: 'deal', title: 'Сделки: Минск', dealScope: 'plain', categoryId: 0, total: 4 })
    expect(sent.filter).toMatchObject({ CATEGORY_ID: 0, MYCOMPANY_ID: 10, ASSIGNED_BY_ID: 101 })
    expect(drill.open.value).toBe(false)
    // Строки читает уже открытый слайдер — этот композабл портал ни о чём не спрашивает.
    expect(portal.calls).toHaveLength(0)
  })

  /**
   * ⚠ Слайдер отказал (мобильное приложение) — панель остаётся запасным путём. Клик, после
   * которого ничего не произошло, читается как поломка отчёта.
   */
  it('слайдер отказал — открывается панель внутри отчёта', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Сделки: Минск', { CATEGORY_ID: 0 }, { companyId: 10 }, 1))
    await nextTick()
    await nextTick()
    expect(drill.open.value).toBe(true)
  })

  it('карточка открывается в слайдере портала', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Сделки', {}, { companyId: 10 }, 1))
    await nextTick()
    answer(1)
    await nextTick()
    await drill.openRow(drill.rows.value[0]!)
    expect(portal.opened).toEqual(['/crm/deal/details/1/'])
  })
})

describe('useManagerDrilldown: когда что-то пошло не так', () => {
  it('ошибка страницы показывается, а повтор идёт с чистой плашкой', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Сделки', {}, { companyId: 10 }, 4))
    await nextTick()
    portal.pending.shift()?.(new Error('портал недоступен'))
    await nextTick()
    expect(drill.error.value).toContain('портал недоступен')
    expect(drill.pending.value).toBe(false)

    void drill.loadMore()
    await nextTick()
    expect(drill.error.value).toBeUndefined()
    answer(1)
    await nextTick()
    expect(drill.rows.value).toHaveLength(1)
  })

  // Клик, после которого ничего не произошло, читается как поломка отчёта — поэтому отказ
  // портала открыть карточку показывается той же плашкой, что и ошибка страницы.
  it('портал не открыл карточку — об этом сказано', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Сделки', {}, { companyId: 10 }, 1))
    await nextTick()
    answer(1)
    await nextTick()
    portal.openFails = true
    expect(await drill.openRow(drill.rows.value[0]!)).toBe(false)
    expect(drill.error.value).toContain('Портал не открыл карточку')
  })

  // Нажали по другому числу, не дождавшись первого списка: опоздавшая страница не должна
  // подмешаться к новому — иначе в списке окажутся записи из двух разных клеток.
  it('нажали по другой клетке — опоздавшая страница выбрасывается', async () => {
    const drill = panel()
    drill.show(drill.cellRequest('Первая', {}, { companyId: 10, stageId: 'NEW' }, 4))
    await nextTick()
    const late = portal.pending.shift()
    drill.show(drill.cellRequest('Вторая', {}, { companyId: 20, stageId: '1' }, 2))
    await nextTick()
    late?.([{ ID: '999', TITLE: 'Из первого списка' }])
    await nextTick()
    expect(drill.rows.value.some(row => row.title === 'Из первого списка')).toBe(false)
    expect(drill.request.value?.title).toBe('Вторая')
  })
})
