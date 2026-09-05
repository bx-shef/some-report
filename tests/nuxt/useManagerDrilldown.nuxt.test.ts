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
  openFails: false
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
})

const DICTIONARIES: ReportDictionaries = {
  sources: { CALL: 'Звонок' },
  junkReasons: {},
  lossReasons: {},
  dealStages: { NEW: 'Новая' },
  users: { 1: 'Иванов Иван' }
}

const FILTERS: ManagerFilters = { categoryId: 0, scope: 'in-work' }

function live(isDemo = false) {
  return useManagerDrilldown({ filters: ref(FILTERS), dictionaries: ref(DICTIONARIES), isDemo: ref(isDemo) })
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
    const drill = live()
    const base = { CATEGORY_ID: 0, STAGE_SEMANTIC_ID: 'P' }
    drill.show(drill.cellRequest('Сделки: Минск · Иванов Иван · Новая', base, { officeId: 10, managerId: 1, stageId: 'NEW' }, 4))
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
    const drill = live()
    drill.show(drill.cellRequest('Сделки', {}, { officeId: 10 }, 2))
    await nextTick()
    answer(2)
    await nextTick()
    expect(drill.rows.value[0]).toMatchObject({ title: 'Сделка 1', stage: 'Новая', manager: 'Иванов Иван', source: 'Звонок' })
    expect(drill.rows.value[0]!.path).toBe('/crm/deal/details/1/')
  })

  it('короткая страница закрывает список, полная — оставляет курсор', async () => {
    const drill = live()
    drill.show(drill.cellRequest('Сделки', {}, { officeId: 10 }, 60))
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

  it('закрытие слайдера выбрасывает страницу, которая ещё шла', async () => {
    const drill = live()
    drill.show(drill.cellRequest('Сделки', {}, { officeId: 10 }, 4))
    await nextTick()
    drill.open.value = false
    await nextTick()
    answer(3)
    await nextTick()
    expect(drill.rows.value).toHaveLength(0)
  })

  it('в демо-режиме список собирается по строкам набора, без запросов к порталу', async () => {
    const drill = live(true)
    drill.show(drill.cellRequest('Сделки', {}, { officeId: 10, managerId: 101, stageId: 'NEW' }, 4))
    await nextTick()
    expect(portal.calls).toHaveLength(0)
    expect(drill.done.value).toBe(true)
    expect(drill.rows.value.length).toBeGreaterThan(0)
    // Карточек в CRM у демо-строк нет — открывать нечего, и слайдер об этом говорит сам.
    expect(drill.rows.value.every(row => row.path === '')).toBe(true)
  })

  it('карточка открывается в слайдере портала', async () => {
    const drill = live()
    drill.show(drill.cellRequest('Сделки', {}, { officeId: 10 }, 1))
    await nextTick()
    answer(1)
    await nextTick()
    await drill.openRow(drill.rows.value[0]!)
    expect(portal.opened).toEqual(['/crm/deal/details/1/'])
  })
})

describe('useManagerDrilldown: когда что-то пошло не так', () => {
  it('ошибка страницы показывается, а повтор идёт с чистой плашкой', async () => {
    const drill = live()
    drill.show(drill.cellRequest('Сделки', {}, { officeId: 10 }, 4))
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
    const drill = live()
    drill.show(drill.cellRequest('Сделки', {}, { officeId: 10 }, 1))
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
    const drill = live()
    drill.show(drill.cellRequest('Первая', {}, { officeId: 10, stageId: 'NEW' }, 4))
    await nextTick()
    const late = portal.pending.shift()
    drill.show(drill.cellRequest('Вторая', {}, { officeId: 20, stageId: '1' }, 2))
    await nextTick()
    late?.([{ ID: '999', TITLE: 'Из первого списка' }])
    await nextTick()
    expect(drill.rows.value.some(row => row.title === 'Из первого списка')).toBe(false)
    expect(drill.request.value?.title).toBe('Вторая')
  })
})
