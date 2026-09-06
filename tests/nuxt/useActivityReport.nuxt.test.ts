// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { CALL_MAX_PAGES, useActivityReport } from '~/composables/useActivityReport'
import { NO_USER_LABEL, totalCalls } from '~/utils/activityLoad'

/**
 * Выборка отчёта «Активность пользователей» из портала.
 *
 * ⚠ Портал здесь не «заглушка с готовыми числами», а МОДЕЛЬ: он держит дела, лиды и звонки и
 * отвечает на те же вопросы, что настоящий, — вместе с тремя его конвенциями, каждая из которых
 * уже стоила этому проекту боевого дефекта:
 *
 * 1. `voximplant.statistic.get` понимает только ЗАГЛАВНЫЙ `FILTER`; строчный он игнорирует и
 *    отдаёт весь портал за всё время;
 * 2. `department.get` не понимает `filter` ВООБЩЕ (проверено на боевом: курсор `>ID` не
 *    применился) и листается только `start`;
 * 3. одиночный `user.get` — ловушка: сотрудников читает `callList`.
 *
 * Стенд, который щедрее портала, зеленел бы при сломанном отчёте — этот проект такое уже проходил.
 */

const TODAY = new Date()
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const CREATED = `${iso(TODAY)}T10:00:00+03:00`

const portal = vi.hoisted(() => ({
  initialized: true,
  batches: 0,
  /** Сколько страниц телефонии спросили — по нему видно параллельность и признак конца. */
  callPages: 0,
  callsFail: false,
  /** Портал отвечает ошибкой на пакет счётчиков. */
  batchFails: false,
  /** Отделы отвечают ошибкой — фильтр обязан сказать об этом, а не потерять людей молча. */
  departmentsFail: false,
  /** Телефония НИКОГДА не отдаёт короткую страницу: так проверяется предохранитель по страницам. */
  callsEndless: false,
  users: [] as Array<Record<string, unknown>>,
  dismissedUsers: [] as Array<Record<string, unknown>>,
  departments: [] as Array<Record<string, unknown>>,
  activities: [] as Array<Record<string, unknown>>,
  leads: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Record<string, unknown>>
}))

/** Совпадает ли запись с фильтром REST — те же ключи, что шлёт отчёт. */
function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('>=') || key.startsWith('<=') || key.startsWith('<') || key.startsWith('>')) {
      const field = key.replace(/^[><=]+/, '')
      const own = String(row[field] ?? '')
      if (key.startsWith('>=')) {
        if (own < String(value)) return false
        continue
      }
      if (key.startsWith('<=')) {
        if (own > String(value)) return false
        continue
      }
      if (key.startsWith('<')) {
        if (own >= String(value)) return false
        continue
      }
      if (own <= String(value)) return false
      continue
    }
    if (String(row[key] ?? '') !== String(value)) return false
  }
  return true
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
            const data: Record<string, { getTotal: () => number, getData: () => { result: unknown[] } }> = {}
            for (const [key, command] of Object.entries(calls)) {
              const filter = (command.params.filter ?? {}) as Record<string, unknown>
              const source = command.method === 'crm.lead.list' ? portal.leads : portal.activities
              const rows = source.filter(row => matches(row, filter))
              data[key] = { getTotal: () => rows.length, getData: () => ({ result: [] }) }
            }
            return { isSuccess: true, getData: () => data, getErrorMessages: () => [] }
          }
        },
        callList: {
          make: async ({ method, params }: { method: string, params: Record<string, unknown> }) => {
            // ⛔ `callList` годится ТОЛЬКО для `user.get`: у `department.get` нет `filter` вовсе,
            // и курсор `>ID` там молча не применится (замер боевого портала).
            if (method !== 'user.get') throw new Error(`callList не для ${method}: курсор уедет в никуда`)
            const active = (params as { filter?: { ACTIVE?: unknown } }).filter?.ACTIVE !== false
            const rows = active ? portal.users : portal.dismissedUsers
            return { isSuccess: true, getData: () => rows, getErrorMessages: () => [] }
          }
        },
        call: {
          make: async ({ method, params }: { method: string, params: Record<string, unknown> }) => {
            const ok = (result: unknown) => ({ isSuccess: true, getData: () => ({ result }), getErrorMessages: () => [] })
            if (method === 'user.get') throw new Error('user.get одиночным вызовом: сотрудников читает callList')
            if (method === 'department.get') {
              // ⚠ Как живой портал: `filter` не понимает вовсе, страницы только по `start`.
              if ('filter' in params) throw new Error('department.get не принимает filter')
              if (portal.departmentsFail) throw new Error('лимит запросов')
              const start = Number(params.start ?? 0)
              return ok(portal.departments.slice(start, start + 50))
            }
            if (method === 'voximplant.statistic.get') {
              if (portal.callsFail) return { isSuccess: false, getData: () => undefined, getErrorMessages: () => ['лимит запросов'] }
              portal.callPages++
              // ⛔ Строчный `filter` метод НЕ понимает: он вернул бы весь портал за всё время.
              if ('filter' in params) throw new Error('voximplant.statistic.get требует ЗАГЛАВНЫЙ FILTER')
              // Портал, у которого звонки не кончаются: каждая страница ПОЛНАЯ.
              if (portal.callsEndless) {
                return ok(Array.from({ length: 50 }, (_, i) => call(portal.callPages * 50 + i, 1, '1', '120')))
              }
              const filter = (params.FILTER ?? {}) as Record<string, unknown>
              const rows = portal.calls.filter(row => matches(row, filter))
              const start = Number(params.start ?? 0)
              return ok(rows.slice(start, start + 50))
            }
            throw new Error(`неожиданный метод ${method}`)
          }
        }
      }
    }
  })
}))

function activity(id: number, responsible: number, typeId: number, direction = 0): Record<string, unknown> {
  return { ID: id, RESPONSIBLE_ID: responsible, TYPE_ID: typeId, DIRECTION: direction, CREATED, COMPLETED: 'Y', END_TIME: CREATED }
}

function call(id: number, userId: number | '', type: '1' | '2', duration: string, failed = '200'): Record<string, unknown> {
  return { ID: id, PORTAL_USER_ID: userId, CALL_TYPE: type, CALL_DURATION: duration, CALL_FAILED_CODE: failed, CALL_START_DATE: CREATED }
}

beforeEach(() => {
  portal.initialized = true
  portal.batches = 0
  portal.callPages = 0
  portal.callsFail = false
  portal.batchFails = false
  portal.departmentsFail = false
  portal.callsEndless = false
  portal.users = [
    { ID: '1', NAME: 'Иван', LAST_NAME: 'Иванов', UF_DEPARTMENT: [11] },
    { ID: '2', NAME: 'Пётр', LAST_NAME: 'Петров', UF_DEPARTMENT: [12] }
  ]
  portal.dismissedUsers = [{ ID: '3', NAME: 'Семён', LAST_NAME: 'Семёнов', ACTIVE: false, UF_DEPARTMENT: [11] }]
  portal.departments = [
    { ID: '10', NAME: 'Департамент' },
    { ID: '11', NAME: 'Отдел продаж', PARENT: '10' },
    { ID: '12', NAME: 'Отдел закупок', PARENT: '10' }
  ]
  // Письма: два исходящих у Иванова, одно входящее у Петрова. Встреча — у Иванова.
  portal.activities = [
    activity(1, 1, 4, 2), activity(2, 1, 4, 2), activity(3, 2, 4, 1), activity(4, 1, 1, 0)
  ]
  portal.leads = [{ ID: 1, ASSIGNED_BY_ID: 1, DATE_CREATE: iso(TODAY) }]
  portal.calls = [
    call(1, 1, '1', '120'), call(2, 1, '2', '90'), call(3, 2, '1', '200'),
    call(4, 1, '1', '0', '304'), call(5, 1, '1', '29'), call(6, '', '2', '0', '304')
  ]
})

/** Дождаться конца фонового чтения звонков: `load()` его не ждёт намеренно. */
async function waitForCalls(state: { callsPending: { value: boolean } }): Promise<void> {
  for (let i = 0; i < 50 && state.callsPending.value; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('useActivityReport', () => {
  it('считает дела и лиды счётчиками и показывает таблицу ДО звонков', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load()
    // Звонки идут фоном — на этот момент их ещё нет, и отчёт обязан об этом говорить.
    expect(state.report.value.callsKnown).toBe(false)
    expect(state.report.value.rows.length).toBeGreaterThan(0)
    const ivanov = state.report.value.rows.find(row => row.userId === 1)
    expect(ivanov?.deeds.email.out).toBe(2)
    expect(ivanov?.deeds.email.in).toBe(0)
    expect(ivanov?.deeds.meeting).toBe(1)
    expect(ivanov?.leads.created).toBe(1)
  })

  it('звонки доезжают фоном и встают в те же строки', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load()
    await waitForCalls(state)
    expect(state.report.value.callsKnown).toBe(true)
    const ivanov = state.report.value.rows.find(row => row.userId === 1)
    // Один исходящий 120 с, один входящий 90 с; недозвон и разговор ровно в порог — отдельно.
    expect(totalCalls(ivanov!)).toEqual({ count: 2, seconds: 210 })
    expect(ivanov?.failed).toBe(1)
    expect(ivanov?.tooShort).toBe(1)
  })

  /** ⚠ У заказчика такие записи есть — звонки на общую линию, которые не подняли. */
  it('звонок без сотрудника получает строку, а дела ему не приписываются', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load()
    await waitForCalls(state)
    const nobody = state.report.value.rows.find(row => row.userName === NO_USER_LABEL)
    expect(nobody?.failed).toBe(1)
    // ⚠ Дел ему не спрашивали — экран обязан поставить прочерк, а не ноль.
    expect(nobody?.deedsKnown).toBe(false)
  })

  it('уволенный есть в таблице и помечен', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load()
    const fired = state.report.value.rows.find(row => row.userId === 3)
    expect(fired?.userName).toBe('Семёнов Семён')
    expect(fired?.dismissed).toBe(true)
  })

  /** ⚠ Отдел берётся ПОДДЕРЕВОМ: узел «Департамент» — это оба отдела под ним. */
  it('фильтр отдела сужает таблицу и берёт подотделы', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load({ ...state.filters.value, departmentId: 11 })
    expect(state.report.value.rows.map(row => row.userId).sort()).toEqual([1, 3])

    await state.load({ ...state.filters.value, departmentId: 10 })
    expect(state.report.value.rows.map(row => row.userId).sort()).toEqual([1, 2, 3])
  })

  it('отделы прочитаны и предложены фильтру', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load()
    expect(state.departments.value.map(d => d.name)).toContain('Отдел продаж')
    expect(state.departments.value.find(d => d.id === 11)?.parentId).toBe(10)
  })

  /** Порог — настройка отчёта: он обязан менять числа, а не только подпись. */
  it('порог доезжает до счёта звонков', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load({ ...state.filters.value, thresholdSeconds: 150 })
    await waitForCalls(state)
    const ivanov = state.report.value.rows.find(row => row.userId === 1)
    expect(totalCalls(ivanov!).count).toBe(0)
    expect(ivanov?.tooShort).toBe(3)
    expect(state.report.value.thresholdSeconds).toBe(150)
  })

  /**
   * ⚠ Ошибка ЗВОНКОВ — не ошибка отчёта: дела и лиды посчитаны и верны. Общая плашка «не удалось
   * прочитать данные» заставила бы человека не верить верным числам.
   */
  it('сбой звонков не рушит таблицу и называется отдельно', async () => {
    portal.callsFail = true
    const state = useActivityReport({ today: TODAY })
    await state.load()
    await waitForCalls(state)
    expect(state.error.value).toBeUndefined()
    expect(state.callsError.value).toContain('лимит запросов')
    expect(state.report.value.rows.find(row => row.userId === 1)?.deeds.email.out).toBe(2)
  })

  it('сбой счётчиков отчёт называет, а не показывает нули', async () => {
    portal.batchFails = true
    const state = useActivityReport({ today: TODAY })
    await state.load()
    expect(state.error.value).toContain('портал недоступен')
  })

  /**
   * ⚠ Фоновое чтение живёт полторы минуты и переживает смену отбора. Без сторожа звонки прошлого
   * периода дописались бы в таблицу нового.
   */
  it('звонки устаревшего отбора в новую таблицу не попадают', async () => {
    const state = useActivityReport({ today: TODAY })
    const first = state.load()
    await state.load({ ...state.filters.value, departmentId: 12 })
    await first
    await waitForCalls(state)
    // Под отделом 12 остаётся только Петров; Иванова в таблице быть не должно ни в каком виде.
    expect(state.report.value.rows.some(row => row.userId === 1)).toBe(false)
  })

  it('вне портала — демо-набор, и он это признаёт', async () => {
    portal.initialized = false
    const state = useActivityReport({ today: TODAY })
    await state.load()
    expect(state.isDemo.value).toBe(true)
    expect(state.report.value.rows.length).toBeGreaterThan(0)
  })
})

describe('useActivityReport: предохранители и кэш звонков', () => {
  /**
   * ⚠ «Молча показанная половина хуже честного „здесь не всё“» — правило проекта. Если условие
   * выхода из цикла сломается или `callsTruncated` перестанут ставить, отчёт покажет часть
   * звонков как итог, и заметить это можно будет только сверкой с CRM вручную.
   */
  it('звонков больше предела — отчёт говорит об этом и останавливается', async () => {
    portal.callsEndless = true
    const state = useActivityReport({ today: TODAY })
    await state.load()
    await waitForCalls(state)
    expect(state.callsTruncated.value).toBe(true)
    // Читать бесконечно нельзя: предел страниц — жёсткий.
    expect(portal.callPages).toBeLessThanOrEqual(CALL_MAX_PAGES)
    expect(state.callsPending.value).toBe(false)
  })

  /**
   * ⛔ Сбой справочника отделов — самый тихий из возможных: поддерево схлопывается в один узел, и
   * сотрудники ПОДотделов исчезают из таблицы при верных числах у остальных.
   */
  it('сбой справочника отделов не молчит и не теряет людей тайком', async () => {
    portal.departmentsFail = true
    const state = useActivityReport({ today: TODAY })
    await state.load({ ...state.filters.value, departmentId: 10 })
    expect(state.departmentsIncomplete.value).toBe(true)
    // Числа остальных при этом посчитаны: сбой отделов — не ошибка отчёта.
    expect(state.error.value).toBeUndefined()
  })

  /**
   * ⛔ Главный случай: справочник УЖЕ прочитан, а следующий ответ портала пуст (лимит запросов).
   * Считать по пустому свежему ответу — значит схлопнуть поддерево в один узел и молча потерять
   * сотрудников подотделов при верных числах у остальных. Отделы за минуту не меняются, и прошлый
   * справочник рядом — верен.
   */
  it('оборвавшийся справочник не отменяет уже прочитанное дерево', async () => {
    const state = useActivityReport({ today: TODAY })
    // Первый проход читает дерево целиком: 10 — узел, 11 и 12 — подотделы.
    await state.load()
    expect(state.departments.value).toHaveLength(3)

    // Второй — портал отвечает отказом, но дерево уже известно.
    portal.departmentsFail = true
    await state.load({ ...state.filters.value, departmentId: 10 })
    expect(state.departmentsIncomplete.value).toBe(false)
    // Поддерево сработало: в отделе 10 — все трое, включая тех, кто в подотделах 11 и 12.
    expect(state.report.value.rows.map(row => row.userId).sort()).toEqual([1, 2, 3])
  })

  it('без выбранного отдела сбой справочника отчёту не мешает', async () => {
    portal.departmentsFail = true
    const state = useActivityReport({ today: TODAY })
    await state.load()
    expect(state.departmentsIncomplete.value).toBe(false)
    expect(state.report.value.rows.length).toBeGreaterThan(0)
  })

  /** ⚠ Отделов может быть больше страницы: `department.get` листается смещением, по 50. */
  it('отделы читаются страницами, а не первой страницей', async () => {
    portal.departments = Array.from({ length: 63 }, (_, i) => ({ ID: String(1000 + i), NAME: `Отдел ${i}` }))
    const state = useActivityReport({ today: TODAY })
    await state.load()
    expect(state.departments.value).toHaveLength(63)
  })

  /**
   * ⛔ Порог применяет ЯДРО, а не портал: перечитывать звонки при его смене нечего. Без кэша
   * человек, меняющий порог, получал бы вторую двухминутную выборку — и настройка, сделанная
   * ради быстрого ответа, оказалась бы самой дорогой кнопкой отчёта.
   */
  it('смена порога пересчитывает из кэша, не трогая портал', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load()
    await waitForCalls(state)
    const pagesAfterFirst = portal.callPages
    expect(pagesAfterFirst).toBeGreaterThan(0)

    await state.load({ ...state.filters.value, thresholdSeconds: 150 })
    await waitForCalls(state)
    // Ни одной новой страницы телефонии: период тот же.
    expect(portal.callPages).toBe(pagesAfterFirst)
    // А числа при этом ДРУГИЕ — пересчёт действительно случился.
    expect(state.report.value.thresholdSeconds).toBe(150)
    expect(state.report.value.rows.find(row => row.userId === 1)?.tooShort).toBe(3)
  })

  /** ⚠ Сменился ПЕРИОД — записи другие, кэш недействителен, портал спрашиваем заново. */
  it('смена периода перечитывает звонки', async () => {
    const state = useActivityReport({ today: TODAY })
    await state.load()
    await waitForCalls(state)
    const pagesAfterFirst = portal.callPages

    await state.load({ ...state.filters.value, period: { from: '2020-01-01', to: '2020-01-31' } })
    await waitForCalls(state)
    expect(portal.callPages).toBeGreaterThan(pagesAfterFirst)
  })
})
