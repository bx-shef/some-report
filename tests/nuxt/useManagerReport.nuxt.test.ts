// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { useManagerReport } from '~/composables/useManagerReport'
import ManagersPage from '~/pages/app/managers.vue'
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
  /** Портал отвечает ошибкой на пакет: отчёт обязан сказать об этом, а не показать нули. */
  batchFails: false,
  /** Направление, ответы по которому приходят с задержкой, — для проверки гонки. */
  slowCategory: undefined as number | undefined,
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
            if (portal.batchFails) return { isSuccess: false, getData: () => undefined, getErrorMessages: () => ['портал недоступен'] }
            // Медленное направление отвечает позже быстрого — так проверяется гонка отборов.
            const anyFilter = Object.values(calls)[0]?.params as { filter?: Record<string, unknown> } | undefined
            if (portal.slowCategory !== undefined && Number(anyFilter?.filter?.CATEGORY_ID) === portal.slowCategory) {
              await new Promise(resolve => setTimeout(resolve, 30))
            }
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
  portal.batchFails = false
  portal.slowCategory = undefined
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

describe('useManagerReport: сколько стоит выборка', () => {
  // ⚠ Счётчики — главная цена отчёта. Лишний проход по парам или клеткам не виден на экране, но
  // удваивает число вопросов к порталу; здесь это зафиксировано числом.
  it('пакетов ровно столько, сколько шагов выборки', async () => {
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    // справочники + цепочка офисов + цепочка менеджеров + счётчики (офисы, колонки, пары) + клетки
    expect(portal.batches).toBe(5)
  })

  it('счётчики клеток спрашиваются только по непустым парам', async () => {
    const state = useManagerReport()
    // Направление 1: одна сделка, значит одна пара — клеток столько же, сколько стадий охвата.
    await state.load({ categoryId: 1, scope: 'in-work' })
    expect(state.report.value.total).toBe(1)
    expect(portal.batches).toBe(5)
  })
})

describe('useManagerReport: когда что-то пошло не так', () => {
  it('ошибка портала показывается, а не превращается в нули', async () => {
    portal.batchFails = true
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    expect(state.error.value).toContain('портал недоступен')
    expect(state.pending.value).toBe(false)
    expect(state.report.value.total).toBe(0)
    // Отбор не считается применённым: на экране не должно быть подписи под числами, которых нет.
    expect(state.source.value).toBe('mock')
  })

  it('под пустым отбором — пустой отчёт без единого остатка', async () => {
    portal.deals = []
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    expect(state.error.value).toBeUndefined()
    expect(state.report.value.total).toBe(0)
    expect(state.report.value.offices).toEqual([])
    expect(state.report.value.unlisted).toBe(0)
  })

  // Медленный ответ прошлого отбора приходит ПОСЛЕ быстрого ответа нового — и не должен его
  // затирать: иначе на экране числа одного направления под подписью другого.
  it('спросили первым, ответил последним — на экране всё равно свежий отбор', async () => {
    portal.slowCategory = 0
    const state = useManagerReport()
    const slow = state.load({ categoryId: 0, scope: 'in-work' })
    const fast = state.load({ categoryId: 1, scope: 'in-work' })
    await Promise.all([fast, slow])
    expect(state.filters.value.categoryId).toBe(1)
    expect(state.report.value.total).toBe(1)
  })
})

describe('useManagerReport: перечисление упёрлось в предел', () => {
  it('менеджеров больше, чем отчёт перечисляет за проход — признак поднят', async () => {
    // 501 сотрудник: цепочка (10 пакетов по 50) исчерпает предел и не дойдёт до последнего.
    portal.deals = Array.from({ length: 501 }, (_, index) => deal(1000 + index, 10, index + 1, 'NEW'))
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    expect(state.truncatedManagers.value).toBe(true)
    expect(state.truncatedOffices.value).toBe(false)
    // Сделки не потеряны: то, что не разложено по строкам, видно остатком.
    expect(state.report.value.total).toBe(501)
    expect(state.report.value.unlisted).toBeGreaterThan(0)
  }, 60_000)
})

describe('useManagerReport: стадии по кнопке', () => {
  /** Много пар: 20 сотрудников × 5 стадий охвата даёт больше клеток, чем считается само. */
  function crowd() {
    portal.stages = Array.from({ length: 60 }, (_, index) => ({ STATUS_ID: `S${index}`, NAME: `Стадия ${index}`, SEMANTICS: null }))
    portal.deals = Array.from({ length: 20 }, (_, index) => deal(2000 + index, 10, index + 1, `S${index % 60}`))
  }

  it('клеток слишком много — таблица без колонок и кнопка с оценкой времени', async () => {
    crowd()
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    expect(state.stagesDeferred.value).toBe(true)
    expect(state.stagesEstimateSeconds.value).toBeGreaterThan(0)
    expect(state.report.value.stages).toEqual([])
    // ⚠ Ни одной сделки при этом не должно оказаться в «прочих стадиях»: колонок не просили.
    expect(state.report.value.otherStages).toBe(0)
    expect(state.report.value.total).toBe(20)
  })

  it('кнопка досчитывает стадии, не спрашивая пары заново', async () => {
    crowd()
    const state = useManagerReport()
    await state.load({ categoryId: 0, scope: 'in-work' })
    const before = portal.batches
    await state.startStages()
    expect(state.stagesDeferred.value).toBe(false)
    expect(state.report.value.stages.length).toBeGreaterThan(0)
    expect(state.report.value.total).toBe(20)
    // Досчёт — это ТОЛЬКО клетки: 20 строк × 60 стадий = 1200 вопросов, то есть 24 пакета.
    // Ни справочники, ни цепочки, ни счётчики пар заново не спрашиваются.
    expect(portal.batches - before).toBe(Math.ceil(20 * 60 / 50))
  })
})

describe('экран отчёта на тех же данных портала', () => {
  /**
   * Дать странице домонтироваться и дождаться выборки: она идёт в `onMounted` и состоит из
   * нескольких запросов подряд, поэтому одного `nextTick` мало — прокручиваем очередь задач.
   */
  async function flush(times = 40) {
    for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }

  it('рисует матрицу по живым данным, а не демо-набор', async () => {
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    const text = wrapper.text()
    expect(text).not.toContain('Это НЕ данные вашего портала')
    expect(text).toContain('Минск')
    expect(text).toContain('Иванов Иван')
    expect(text).toContain('Итого по офису')
  })

  // Полный путь клика: число в таблице → запрос портала тем же условием → строки в слайдере.
  // ⚠ Слайдер живёт в телепорте, вне дерева страницы, — читаем текст всего документа.
  it('клик по числу открывает список сделок этой клетки', async () => {
    document.body.innerHTML = ''
    const wrapper = await mountSuspended(ManagersPage, { attachTo: document.body })
    await flush()
    const cell = wrapper.findAll('tbody button').find(button => button.attributes('title')?.includes('Иванов Иван'))
    expect(cell).toBeTruthy()
    await cell!.trigger('click')
    await flush()
    expect(document.body.textContent ?? '').toContain('Сделки: Минск · Иванов Иван')
  })

  // ⚠ На боевом портале «моя компания» не заполнена у 92 % сделок. Руководитель, увидев почти всё
  // в одной строке, решит, что сломан ОТЧЁТ, — экран обязан объяснить, что дело в поле CRM.
  it('когда «моя компания» почти нигде не заполнена — об этом сказано прямо', async () => {
    portal.deals = [
      deal(1, 10, 1, 'NEW'),
      ...Array.from({ length: 9 }, (_, index) => deal(100 + index, OFFICE_UNSET, 1, 'NEW'))
    ]
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    expect(wrapper.text()).toContain('Поле «Моя компания» у сделок почти не заполнено')
  })

  it('под пустым отбором экран говорит словами, а не показывает пустую таблицу', async () => {
    portal.deals = []
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    expect(wrapper.text()).toContain('Под этим отбором сделок нет')
  })

  it('при ошибке портала экран не утверждает, что сделок нет', async () => {
    portal.batchFails = true
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    const text = wrapper.text()
    expect(text).toContain('Не удалось прочитать данные портала')
    expect(text).not.toContain('Под этим отбором сделок нет')
  })
})
