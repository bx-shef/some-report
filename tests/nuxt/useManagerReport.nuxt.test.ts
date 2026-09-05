// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useManagerReport } from '~/composables/useManagerReport'
import { OFFICE_UNSET } from '~/utils/managerLoad'

/**
 * Выборка отчёта «Сделки по менеджерам» из портала.
 *
 * ⚠ Портал здесь не «заглушка, отдающая заранее заданные числа», а МОДЕЛЬ: он держит список
 * сделок и отвечает на те же вопросы, что настоящий, — включая цепочку `$result` и её главную
 * ловушку (исчерпанная цепочка идёт по второму кругу). Заглушка с готовыми ответами прошла бы и
 * на коде, который эту ловушку не разбирает, — то есть проверяла бы ровно ничего.
 */
interface FakeDeal {
  ID: number
  CATEGORY_ID: number
  MYCOMPANY_ID: number
  ASSIGNED_BY_ID: number
  STAGE_ID: string
  STAGE_SEMANTIC_ID: 'P' | 'S' | 'F'
  DATE_CREATE: string
}

const portal = vi.hoisted(() => ({
  initialized: true,
  /** Сколько раз портал спросили пакетом — по этому числу видно, что счётчиков не стало вдвое больше. */
  batches: 0,
  usersFail: false,
  deals: [] as Array<Record<string, unknown>>,
  categories: [] as Array<Record<string, unknown>>,
  stages: [] as Array<Record<string, unknown>>
}))

/** Совпадает ли сделка с фильтром REST — те же ключи, что шлёт отчёт. */
function matches(deal: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('>=') || key.startsWith('<')) {
      const field = key.replace(/^[><=]+/, '')
      const own = String(deal[field] ?? '')
      if (key.startsWith('>=') && own < String(value)) return false
      if (key.startsWith('<') && !key.startsWith('<=') && own >= String(value)) return false
      continue
    }
    if (key.startsWith('>')) {
      if (Number(deal[key.slice(1)]) <= Number(value)) return false
      continue
    }
    if (String(deal[key] ?? '') !== String(value)) return false
  }
  return true
}

/** Модель `crm.deal.list`: фильтр, сортировка, `total` и первая строка. */
function dealList(params: Record<string, unknown>) {
  const filter = (params.filter ?? {}) as Record<string, unknown>
  const order = (params.order ?? {}) as Record<string, string>
  let rows = portal.deals.filter(deal => matches(deal, filter))
  const [field] = Object.keys(order)
  if (field) rows = [...rows].sort((a, b) => Number(a[field]) - Number(b[field]))
  return { rows, total: rows.length }
}

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => portal.initialized,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  openPath: async () => true,
  getOrThrow: () => ({
    actions: {
      v2: {
        batch: {
          make: async ({ calls }: { calls: Record<string, { method: string, params: Record<string, unknown> }> }) => {
            portal.batches++
            const data: Record<string, { getTotal: () => number, getData: () => { result: unknown[] } }> = {}
            const answers: Record<string, unknown[]> = {}
            for (const [key, command] of Object.entries(calls)) {
              if (command.method === 'crm.status.list') {
                const entity = ((command.params as { filter?: Record<string, unknown> }).filter ?? {}).ENTITY_ID
                const rows = String(entity).startsWith('DEAL_STAGE') ? portal.stages : []
                answers[key] = rows
                data[key] = { getTotal: () => rows.length, getData: () => ({ result: rows }) }
                continue
              }
              // ⚠ Ссылка `$result[cmd][0][ПОЛЕ]` на ответ предыдущей команды. Не разрешилась —
              // портал подставляет пустоту, фильтр `>ПОЛЕ` пропадает, и цепочка идёт СНАЧАЛА.
              const params = { ...command.params } as Record<string, unknown>
              const filter = { ...(params.filter ?? {}) as Record<string, unknown> }
              for (const [name, value] of Object.entries(filter)) {
                const match = typeof value === 'string' ? /^\$result\[(\w+)]\[0]\[(\w+)]$/.exec(value) : null
                if (!match) continue
                const previous = answers[match[1]!]?.[0] as Record<string, unknown> | undefined
                filter[name] = previous?.[match[2]!] ?? 0
              }
              params.filter = filter
              const { rows, total } = dealList(params)
              const page = params.start === -1 || params.start === 0 ? rows.slice(0, 50) : rows
              answers[key] = page
              data[key] = { getTotal: () => total, getData: () => ({ result: page }) }
            }
            return { isSuccess: true, getData: () => data, getErrorMessages: () => [] }
          }
        },
        call: {
          make: async ({ method, params }: { method: string, params: Record<string, unknown> }) => {
            const ok = (result: unknown) => ({ isSuccess: true, getData: () => ({ result }), getErrorMessages: () => [] })
            if (method === 'crm.category.list') return ok({ categories: portal.categories })
            if (method === 'crm.status.list') return ok(portal.stages)
            if (method === 'crm.company.list') return ok([{ ID: '10', TITLE: 'Минск' }, { ID: '20', TITLE: 'Гомель' }])
            if (method === 'user.get') {
              if (portal.usersFail) throw new Error('insufficient_scope')
              return ok([{ ID: '1', NAME: 'Иван', LAST_NAME: 'Иванов' }, { ID: '2', NAME: 'Пётр', LAST_NAME: 'Петров' }])
            }
            if (method === 'crm.deal.list') return ok(dealList(params).rows)
            throw new Error(`неожиданный метод ${method}`)
          }
        }
      }
    }
  })
}))

function deal(id: number, officeId: number, managerId: number, stageId: string, extra: Partial<FakeDeal> = {}): Record<string, unknown> {
  return {
    ID: id,
    CATEGORY_ID: 0,
    MYCOMPANY_ID: officeId,
    ASSIGNED_BY_ID: managerId,
    STAGE_ID: stageId,
    STAGE_SEMANTIC_ID: 'P',
    DATE_CREATE: '2026-09-01',
    ...extra
  }
}

beforeEach(() => {
  portal.initialized = true
  portal.batches = 0
  portal.usersFail = false
  portal.categories = [{ id: 0, name: 'Общее направление', isDefault: 'Y' }, { id: 1, name: 'Оптовые продажи' }]
  portal.stages = [
    { STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: null },
    { STATUS_ID: '1', NAME: 'Выставлен счёт', SEMANTICS: null },
    { STATUS_ID: 'WON', NAME: 'Успех', SEMANTICS: 'S' }
  ]
  portal.deals = [
    deal(1, 10, 1, 'NEW'),
    deal(2, 10, 1, '1'),
    deal(3, 10, 2, 'NEW'),
    deal(4, 20, 2, '1'),
    deal(5, OFFICE_UNSET, 1, 'NEW'),
    // Успешная — в охват «в работе» не попадает.
    deal(6, 10, 1, 'WON', { STAGE_SEMANTIC_ID: 'S' }),
    // Чужое направление — тоже мимо.
    deal(7, 10, 2, 'NEW', { CATEGORY_ID: 1 })
  ]
})

describe('useManagerReport: живая выборка', () => {
  it('строит матрицу офис → менеджер → стадия по счётчикам портала', async () => {
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })

    expect(state.report.value.total).toBe(5)
    expect(state.report.value.offices.map(office => office.officeId)).toEqual([10, 20, OFFICE_UNSET])
    const minsk = state.report.value.offices[0]!
    expect(minsk.officeName).toBe('Минск')
    expect(minsk.total).toBe(3)
    expect(minsk.rows.map(row => [row.managerName, row.total])).toEqual([['Иванов Иван', 2], ['Петров Пётр', 1]])
    expect(minsk.rows[0]!.byStage).toEqual({ NEW: 1, 1: 1 })
  })

  it('колонки — только стадии охвата, успешная стадия в «в работе» не попадает', async () => {
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    expect(state.report.value.stages.map(stage => stage.id)).toEqual(['NEW', '1'])
    expect(state.stages.value.map(stage => stage.id)).toEqual(['NEW', '1', 'WON'])
  })

  it('охват «успешные» считает по семантике портала, а не по коду стадии', async () => {
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'won' })
    expect(state.report.value.total).toBe(1)
    expect(state.report.value.stages.map(stage => stage.id)).toEqual(['WON'])
  })

  it('другое направление — другая выборка', async () => {
    const state = useManagerReport()
    await state.load({ categoryId: 1, scope: 'in-work' })
    expect(state.report.value.total).toBe(1)
    expect(state.filters.value.categoryId).toBe(1)
  })

  // Ответственный не назначен — цепочка его не находит (перечисление идёт со значений > 0), и
  // сделка обязана оказаться в остатке, а не пропасть из отчёта.
  it('сделка без ответственного попадает в остаток «вне строк»', async () => {
    portal.deals.push(deal(8, 10, 0, 'NEW'))
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    const minsk = state.report.value.offices.find(office => office.officeId === 10)!
    expect(minsk.total).toBe(4)
    expect(minsk.unlisted).toBe(1)
    expect(state.report.value.unlisted).toBe(1)
  })

  // Стадию удалили из воронки, а сделки на ней остались: сумма колонок меньше итога строки.
  it('сделка на стадии вне справочника — остаток «прочие стадии»', async () => {
    portal.deals.push(deal(9, 10, 1, 'DELETED_STAGE'))
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    const row = state.report.value.offices[0]!.rows[0]!
    expect(row.total).toBe(3)
    expect(row.otherStages).toBe(1)
  })

  it('несуществующее направление подменяется первым из справочника', async () => {
    const state = useManagerReport()
    await state.load({ categoryId: 42, scope: 'in-work' })
    expect(state.filters.value.categoryId).toBe(0)
    expect(state.report.value.total).toBe(5)
  })

  it('без списка сотрудников отчёт остаётся, а строки подписаны номером', async () => {
    portal.usersFail = true
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    expect(state.error.value).toBeUndefined()
    expect(state.report.value.offices[0]!.rows[0]!.managerName).toBe('Сотрудник #1')
  })

  it('период уходит в фильтр по дате создания сделки', async () => {
    portal.deals.push(deal(10, 10, 1, 'NEW', { DATE_CREATE: '2026-07-15' }))
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work', period: { from: '2026-07-01', to: '2026-07-31' } })
    expect(state.report.value.total).toBe(1)
  })

  // Отбор переключают кликами: медленный ответ прошлого отбора не должен затирать свежий.
  it('устаревшая выборка не затирает свежую', async () => {
    const state = useManagerReport()
    const first = state.load({ categoryId: 0, scope: 'in-work' })
    const second = state.load({ categoryId: 1, scope: 'in-work' })
    await Promise.all([first, second])
    expect(state.filters.value.categoryId).toBe(1)
    expect(state.report.value.total).toBe(1)
  })

  it('вне портала остаётся демонстрационный набор и говорит об этом', async () => {
    portal.initialized = false
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    expect(state.isDemo.value).toBe(true)
    expect(state.report.value.total).toBeGreaterThan(0)
    expect(state.categories.value.map(category => category.name)).toContain('Оптовые продажи')
  })
})
