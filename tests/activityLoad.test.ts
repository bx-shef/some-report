import { describe, expect, it } from 'vitest'
import type { ActivityRow, ActivityUser, B24CallRow, DepartmentRef } from '~/types/activity'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import {
  NO_USER_LABEL,
  activityActions,
  activityTotals,
  aggregateCalls,
  averageCallSeconds,
  buildActivityReport,
  callAnswered,
  callDirection,
  deedKey,
  departmentSubtree,
  emptyCallStats,
  emptyDeeds,
  emptyLeads,
  leadKey,
  overdueKey,
  totalCalls,
  totalDeeds,
  usersInDepartment
} from '~/utils/activityLoad'

/**
 * Ядро отчёта «Активность пользователей».
 *
 * ⚠ Проверяем в первую очередь то, что ломается МОЛЧА: направление звонка (перепутать — поменять
 * местами два столбца, и по числам этого не видно), порог разговора (правило заказчика, сдвиг на
 * секунду меняет все числа), поддерево отделов (взять один узел — потерять половину людей) и
 * сходимость итогов со строками.
 */

/** Запись звонка портала: он отдаёт числа СТРОКАМИ, и стенд обязан вести себя так же. */
function call(over: Partial<B24CallRow> = {}): B24CallRow {
  return {
    PORTAL_USER_ID: '7',
    CALL_TYPE: '1',
    CALL_DURATION: '60',
    CALL_FAILED_CODE: '200',
    CALL_START_DATE: '2026-08-04T10:00:00+03:00',
    ...over
  }
}

function user(id: number, name: string, over: Partial<ActivityUser> = {}): ActivityUser {
  return { id, name, ...over }
}

describe('callDirection', () => {
  /**
   * ⛔ Главная ловушка этого отчёта. `CALL_TYPE: 1` — ИСХОДЯЩИЙ, `2` — ВХОДЯЩИЙ: обратно тому, как
   * читается имя фильтра `INCOMING`, и документация значения не расшифровывает вовсе. Проверено на
   * живом портале поимённо, на 38 звонках через связанные дела CRM (`docs/PORTAL.md`). Перепутай —
   * и два столбца отчёта поменяются местами, а числа останутся правдоподобными.
   */
  it('1 — исходящий, 2 — входящий, а не наоборот', () => {
    expect(callDirection(call({ CALL_TYPE: '1' }))).toBe('out')
    expect(callDirection(call({ CALL_TYPE: 1 }))).toBe('out')
    expect(callDirection(call({ CALL_TYPE: '2' }))).toBe('in')
    expect(callDirection(call({ CALL_TYPE: 2 }))).toBe('in')
  })

  /** Неизвестный код не выбрасываем: звонок был, и итог обязан сойтись с суммой столбцов. */
  it('неизвестный код считает исходящим, а не теряет звонок', () => {
    expect(callDirection(call({ CALL_TYPE: '9' }))).toBe('out')
    expect(callDirection(call({ CALL_TYPE: undefined }))).toBe('out')
    expect(callDirection(call({ CALL_TYPE: 'мусор' }))).toBe('out')
  })
})

describe('callAnswered', () => {
  it('состоялся только код 200', () => {
    expect(callAnswered(call({ CALL_FAILED_CODE: '200' }))).toBe(true)
    expect(callAnswered(call({ CALL_FAILED_CODE: 200 }))).toBe(true)
    expect(callAnswered(call({ CALL_FAILED_CODE: '304' }))).toBe(false)
    expect(callAnswered(call({ CALL_FAILED_CODE: '603' }))).toBe(false)
    expect(callAnswered(call({ CALL_FAILED_CODE: undefined }))).toBe(false)
  })
})

describe('aggregateCalls', () => {
  it('раскладывает разговоры по сотрудникам и направлениям', () => {
    const stats = aggregateCalls([
      call({ PORTAL_USER_ID: '7', CALL_TYPE: '1', CALL_DURATION: '100' }),
      call({ PORTAL_USER_ID: '7', CALL_TYPE: '2', CALL_DURATION: '200' }),
      call({ PORTAL_USER_ID: '8', CALL_TYPE: '1', CALL_DURATION: '50' })
    ])
    expect(stats.get(7)?.calls.out).toEqual({ count: 1, seconds: 100 })
    expect(stats.get(7)?.calls.in).toEqual({ count: 1, seconds: 200 })
    expect(stats.get(8)?.calls.out).toEqual({ count: 1, seconds: 50 })
  })

  /**
   * ⚠ Правило заказчика — СТРОГО дольше порога (`>CALL_DURATION` в прежнем отчёте). Ровно 29
   * секунд разговором не считались никогда, и сдвиг на секунду поменял бы все числа отчёта
   * относительно тех, к которым заказчик привык.
   */
  it('порог строгий: ровно порог — уже не разговор', () => {
    const stats = aggregateCalls([
      call({ CALL_DURATION: String(DEFAULT_CALL_THRESHOLD_SECONDS) }),
      call({ CALL_DURATION: String(DEFAULT_CALL_THRESHOLD_SECONDS + 1) })
    ])
    expect(stats.get(7)?.tooShort).toBe(1)
    expect(stats.get(7)?.calls.out).toEqual({ count: 1, seconds: 30 })
  })

  it('порог можно задать — это настройка отчёта, а не константа', () => {
    const rows = [call({ CALL_DURATION: '45' })]
    expect(aggregateCalls(rows).get(7)?.calls.out.count).toBe(1)
    expect(aggregateCalls(rows, { thresholdSeconds: 60 }).get(7)?.calls.out.count).toBe(0)
    expect(aggregateCalls(rows, { thresholdSeconds: 60 }).get(7)?.tooShort).toBe(1)
  })

  it('недозвон и короткий разговор считаются отдельно и не идут в длительность', () => {
    const stats = aggregateCalls([
      call({ CALL_FAILED_CODE: '304', CALL_DURATION: '0' }),
      call({ CALL_FAILED_CODE: '603', CALL_DURATION: '0' }),
      call({ CALL_DURATION: '5' }),
      call({ CALL_DURATION: '120' })
    ]).get(7)
    expect(stats?.failed).toBe(2)
    expect(stats?.tooShort).toBe(1)
    expect(stats?.calls.out).toEqual({ count: 1, seconds: 120 })
  })

  /**
   * ⚠ У недозвона длительность — ноль. Проверь мы сначала порог, каждый недозвон попал бы в
   * «короткие разговоры», и показатель «звонил, но не поговорил» слился бы с «поговорил недолго».
   */
  it('код завершения важнее длительности', () => {
    const stats = aggregateCalls([call({ CALL_FAILED_CODE: '486', CALL_DURATION: '0' })]).get(7)
    expect(stats?.failed).toBe(1)
    expect(stats?.tooShort).toBe(0)
  })

  it('звонок без сотрудника попадает в свою строку, а не пропадает', () => {
    const stats = aggregateCalls([
      call({ PORTAL_USER_ID: '' }),
      call({ PORTAL_USER_ID: undefined }),
      call({ PORTAL_USER_ID: '7' })
    ])
    expect(stats.get(0)?.calls.out.count).toBe(2)
    expect(stats.get(7)?.calls.out.count).toBe(1)
  })

  it('пустой список — пустой счёт, а не поломка', () => {
    expect(aggregateCalls([]).size).toBe(0)
  })
})

describe('departmentSubtree', () => {
  const departments: DepartmentRef[] = [
    { id: 1, name: 'Компания' },
    { id: 10, name: 'Департамент', parentId: 1 },
    { id: 11, name: 'Отдел А', parentId: 10 },
    { id: 12, name: 'Отдел Б', parentId: 10 },
    { id: 20, name: 'Другой департамент', parentId: 1 }
  ]

  /**
   * ⛔ Замер боевого портала: люди сидят и в узлах, и в листьях — у 10 из 11 узлов есть сотрудники
   * ПРЯМО в них. Возьми отчёт только узел — потеряет подотделы; только листья — потеряет тех, кто
   * числится в самом департаменте.
   */
  it('берёт отдел вместе со всеми подотделами', () => {
    expect([...departmentSubtree(departments, 10)].sort((a, b) => a - b)).toEqual([10, 11, 12])
    expect([...departmentSubtree(departments, 1)].sort((a, b) => a - b)).toEqual([1, 10, 11, 12, 20])
    expect([...departmentSubtree(departments, 11)]).toEqual([11])
  })

  it('неизвестный отдел — только он сам, а не всё дерево', () => {
    expect([...departmentSubtree(departments, 999)]).toEqual([999])
  })

  /** ⚠ Дерево приходит от портала: кривая привязка не должна вешать отчёт. */
  it('цикл в дереве не зацикливает обход', () => {
    const looped: DepartmentRef[] = [
      { id: 1, name: 'А', parentId: 2 },
      { id: 2, name: 'Б', parentId: 1 }
    ]
    expect([...departmentSubtree(looped, 1)].sort((a, b) => a - b)).toEqual([1, 2])
  })
})

describe('usersInDepartment', () => {
  const departments: DepartmentRef[] = [
    { id: 10, name: 'Департамент' },
    { id: 11, name: 'Отдел А', parentId: 10 }
  ]
  const users = [
    user(1, 'Один', { departmentIds: [10] }),
    user(2, 'Два', { departmentIds: [11] }),
    user(3, 'Три', { departmentIds: [99] }),
    user(4, 'Четыре', { departmentIds: [99, 11] }),
    user(5, 'Пять')
  ]

  it('без отдела — все сотрудники', () => {
    expect(usersInDepartment(users, departments).map(u => u.id)).toEqual([1, 2, 3, 4, 5])
  })

  /** ⚠ У заказчика 13 совместителей: сравнение с ПЕРВЫМ отделом молча теряло бы их. */
  it('совместитель попадает в каждый свой отдел', () => {
    expect(usersInDepartment(users, departments, 11).map(u => u.id)).toEqual([2, 4])
    expect(usersInDepartment(users, departments, 99).map(u => u.id)).toEqual([3, 4])
  })

  it('отдел берётся с подотделами', () => {
    expect(usersInDepartment(users, departments, 10).map(u => u.id)).toEqual([1, 2, 4])
  })
})

describe('buildActivityReport', () => {
  /** Счётчики портала так и приходят: карта «ключ команды → число». */
  function totals(entries: Record<string, number>): Record<string, number> {
    return entries
  }

  it('раскладывает счётчики дел и лидов по сотрудникам', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.')],
      totals: totals({
        [deedKey(7, 'email', 'in')]: 3,
        [deedKey(7, 'email', 'out')]: 5,
        [deedKey(7, 'meeting')]: 2,
        [deedKey(7, 'task')]: 1,
        [overdueKey(7)]: 4,
        [leadKey(7, 'created')]: 10,
        [leadKey(7, 'won')]: 6,
        [leadKey(7, 'lost')]: 3
      })
    })
    expect(report.rows[0]?.deeds).toEqual({ email: { in: 3, out: 5 }, meeting: 2, task: 1, overdue: 4 })
    expect(report.rows[0]?.leads).toEqual({ created: 10, won: 6, lost: 3 })
    expect(report.rows[0]?.deedsKnown).toBe(true)
  })

  /** ⚠ Порталу верим проверяя: мусор в счётчике обязан стать нулём, а не «NaN» на экране. */
  it('негодный счётчик читается нулём', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.')],
      totals: { [deedKey(7, 'email', 'in')]: Number.NaN, [deedKey(7, 'meeting')]: -5, [deedKey(7, 'task')]: 2.7 }
    })
    expect(report.rows[0]?.deeds.email.in).toBe(0)
    expect(report.rows[0]?.deeds.meeting).toBe(0)
    expect(report.rows[0]?.deeds.task).toBe(2)
  })

  /** ⚠ Пока звонки не приехали, экран обязан знать, что нули в их столбцах — это «ещё читаем». */
  it('без звонков таблица уже собирается и честно про это говорит', () => {
    const report = buildActivityReport({ users: [user(7, 'Иванов И.')], totals: {} })
    expect(report.callsKnown).toBe(false)
    expect(report.rows[0]?.calls).toEqual(emptyCallStats().calls)
    expect(report.rows).toHaveLength(1)
  })

  it('приехавшие звонки встают в строки своих сотрудников', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.'), user(8, 'Петров П.')],
      totals: {},
      calls: aggregateCalls([
        call({ PORTAL_USER_ID: '7', CALL_DURATION: '100' }),
        call({ PORTAL_USER_ID: '7', CALL_DURATION: '200' })
      ])
    })
    expect(report.callsKnown).toBe(true)
    expect(report.rows.find(r => r.userId === 7)?.calls.out).toEqual({ count: 2, seconds: 300 })
    expect(report.rows.find(r => r.userId === 8)?.calls.out).toEqual({ count: 0, seconds: 0 })
  })

  /**
   * ⚠ Звонок сотрудника, которого в списке нет (вне отдела, без `PORTAL_USER_ID`), строку получает
   * — иначе сумма столбца «разговоры» не сошлась бы с итогом. Но дела ему не спрашивали, и ноль в
   * их столбцах читался бы как «не писал» вместо «не спрашивали».
   */
  it('звонки чужого сотрудника дают строку с НЕизвестными делами', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.')],
      totals: {},
      calls: aggregateCalls([
        call({ PORTAL_USER_ID: '99' }),
        call({ PORTAL_USER_ID: '' })
      ])
    })
    const stranger = report.rows.find(r => r.userId === 99)
    expect(stranger?.userName).toBe('Сотрудник #99')
    expect(stranger?.deedsKnown).toBe(false)
    expect(report.rows.find(r => r.userId === 0)?.userName).toBe(NO_USER_LABEL)
    expect(report.rows.find(r => r.userId === 7)?.deedsKnown).toBe(true)
  })

  it('пометка «уволен» — только по признаку портала', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.', { dismissed: true }), user(8, 'Петров П.')],
      totals: {}
    })
    expect(report.rows.find(r => r.userId === 7)?.dismissed).toBe(true)
    expect(report.rows.find(r => r.userId === 8)?.dismissed).toBeUndefined()
  })

  /** Отчёт открывают, чтобы увидеть, кто работает больше. При равенстве — по имени, иначе прыгало бы. */
  it('строки идут по числу действий, при равенстве — по имени', () => {
    const report = buildActivityReport({
      users: [user(1, 'Яковлев'), user(2, 'Абрамов'), user(3, 'Сидоров')],
      totals: { [deedKey(3, 'meeting')]: 5 }
    })
    expect(report.rows.map(r => r.userName)).toEqual(['Сидоров', 'Абрамов', 'Яковлев'])
  })

  it('называет порог, которым считал', () => {
    expect(buildActivityReport({ users: [], totals: {} }).thresholdSeconds)
      .toBe(DEFAULT_CALL_THRESHOLD_SECONDS)
    expect(buildActivityReport({ users: [], totals: {}, thresholdSeconds: 60 }).thresholdSeconds)
      .toBe(60)
  })

  /** Порог обязан доехать до счёта звонков, а не только до подписи под таблицей. */
  it('порог отчёта — тот же, которым посчитаны разговоры', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.')],
      totals: {},
      calls: aggregateCalls([call({ CALL_DURATION: '45' })], { thresholdSeconds: 60 }),
      thresholdSeconds: 60
    })
    expect(report.thresholdSeconds).toBe(60)
    expect(report.rows[0]?.tooShort).toBe(1)
    expect(report.rows[0]?.calls.out.count).toBe(0)
  })

  it('пустой отбор — пустая таблица и нулевые итоги, а не поломка', () => {
    const report = buildActivityReport({ users: [], totals: {} })
    expect(report.rows).toEqual([])
    expect(report.totals.users).toBe(0)
    expect(report.totals.calls.in).toEqual({ count: 0, seconds: 0 })
    expect(report.totals.deeds).toEqual(emptyDeeds())
    expect(report.totals.leads).toEqual(emptyLeads())
  })

  it('итог сходится с суммой строк', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.'), user(8, 'Петров П.')],
      totals: {
        [deedKey(7, 'email', 'out')]: 4,
        [deedKey(8, 'email', 'out')]: 6,
        [deedKey(7, 'meeting')]: 1,
        [overdueKey(8)]: 3,
        [leadKey(7, 'created')]: 5,
        [leadKey(8, 'created')]: 7
      },
      calls: aggregateCalls([
        call({ PORTAL_USER_ID: '7', CALL_DURATION: '100' }),
        call({ PORTAL_USER_ID: '8', CALL_DURATION: '200' }),
        call({ PORTAL_USER_ID: '8', CALL_FAILED_CODE: '304' })
      ])
    })
    expect(report.totals.deeds.email.out).toBe(10)
    expect(report.totals.deeds.meeting).toBe(1)
    expect(report.totals.deeds.overdue).toBe(3)
    expect(report.totals.leads.created).toBe(12)
    expect(report.totals.calls.out).toEqual({ count: 2, seconds: 300 })
    expect(report.totals.failed).toBe(1)
    const sumOut = report.rows.reduce((acc, row) => acc + row.calls.out.seconds, 0)
    expect(sumOut).toBe(report.totals.calls.out.seconds)
  })

  it('в счёт сотрудников идут только те, у кого было хоть одно действие', () => {
    const report = buildActivityReport({
      users: [user(7, 'Иванов И.'), user(8, 'Петров П.'), user(9, 'Сидоров С.')],
      totals: {
        [deedKey(8, 'email', 'out')]: 1,
        // ⚠ Лид — результат, а не действие: одного его мало, чтобы счесть человека работавшим.
        [leadKey(9, 'created')]: 3
      }
    })
    expect(report.totals.users).toBe(1)
  })
})

describe('activityActions', () => {
  function row(over: Partial<ActivityRow> = {}): ActivityRow {
    return {
      userId: 1,
      userName: 'А',
      ...emptyCallStats(),
      deeds: emptyDeeds(),
      leads: emptyLeads(),
      deedsKnown: true,
      ...over
    }
  }

  /** Недозвон — тоже работа: человек набрал номер. */
  it('считает разговоры, недозвоны, короткие и дела', () => {
    expect(activityActions(row({
      calls: { in: { count: 2, seconds: 0 }, out: { count: 3, seconds: 0 } },
      failed: 4,
      tooShort: 5,
      deeds: { email: { in: 6, out: 7 }, meeting: 8, task: 9, overdue: 100 }
    }))).toBe(2 + 3 + 4 + 5 + 6 + 7 + 8 + 9)
  })

  /** ⚠ Лид — результат, а не действие: складывать его с письмами значило бы считать разное. */
  it('лиды в число действий не входят', () => {
    expect(activityActions(row({ leads: { created: 50, won: 20, lost: 30 } }))).toBe(0)
  })

  /** ⚠ Просрочка — состояние на конец периода, а не работа, сделанная в нём. */
  it('просроченные дела в число действий не входят', () => {
    expect(activityActions(row({ deeds: { ...emptyDeeds(), overdue: 42 } }))).toBe(0)
  })
})

describe('activityTotals', () => {
  it('складывает произвольные строки, а не только собранные ядром', () => {
    const totals = activityTotals([
      {
        userId: 1,
        userName: 'А',
        calls: { in: { count: 2, seconds: 100 }, out: { count: 1, seconds: 40 } },
        failed: 3,
        tooShort: 1,
        deeds: { email: { in: 1, out: 2 }, meeting: 3, task: 4, overdue: 5 },
        leads: { created: 6, won: 7, lost: 8 },
        deedsKnown: true
      },
      {
        userId: 2,
        userName: 'Б',
        calls: { in: { count: 0, seconds: 0 }, out: { count: 5, seconds: 500 } },
        failed: 0,
        tooShort: 2,
        deeds: { email: { in: 10, out: 20 }, meeting: 30, task: 40, overdue: 50 },
        leads: { created: 60, won: 70, lost: 80 },
        deedsKnown: true
      }
    ])
    expect(totals.calls.out).toEqual({ count: 6, seconds: 540 })
    expect(totals.calls.in).toEqual({ count: 2, seconds: 100 })
    expect(totals.failed).toBe(3)
    expect(totals.tooShort).toBe(3)
    expect(totals.deeds).toEqual({ email: { in: 11, out: 22 }, meeting: 33, task: 44, overdue: 55 })
    expect(totals.leads).toEqual({ created: 66, won: 77, lost: 88 })
    expect(totals.users).toBe(2)
  })
})

describe('averageCallSeconds', () => {
  it('среднее по разговорам', () => {
    expect(averageCallSeconds({ count: 4, seconds: 200 })).toBe(50)
  })

  /**
   * ⚠ Ноль означал бы «разговоры были и длились нисколько». Пустой период — норма этого отчёта, и
   * `x / 0` напечатало бы «NaN», после чего отчёт перестают читать целиком.
   */
  it('без разговоров среднего нет', () => {
    expect(averageCallSeconds({ count: 0, seconds: 0 })).toBeUndefined()
    expect(averageCallSeconds({ count: 0, seconds: 500 })).toBeUndefined()
  })
})

describe('totalCalls и totalDeeds', () => {
  it('складывает оба направления разговоров', () => {
    expect(totalCalls({
      calls: { in: { count: 2, seconds: 100 }, out: { count: 3, seconds: 200 } },
      failed: 0,
      tooShort: 0
    })).toEqual({ count: 5, seconds: 300 })
  })

  /** ⚠ Просрочка — не «дело за период»: она считается на конец периода и в сумму дел не входит. */
  it('дела за период складываются без просроченных', () => {
    expect(totalDeeds({ email: { in: 1, out: 2 }, meeting: 3, task: 4, overdue: 999 })).toBe(10)
  })
})
