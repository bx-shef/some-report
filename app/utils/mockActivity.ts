import type { ActivityReport, ActivityUser, B24CallRow, DepartmentRef } from '~/types/activity'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import { buildActivityReport, aggregateCalls, deedKey, leadKey, overdueKey, scopeCallsToUsers } from '~/utils/activityLoad'

/**
 * Демонстрационный набор отчёта «Активность пользователей» — для страницы вне портала.
 *
 * ⚠ Задан СЫРЫМИ ЗАПИСЯМИ и СЧЁТЧИКАМИ, а не готовыми итогами. Итоги считает то же ядро, что и на
 * живых данных, — поэтому демо-таблица не может разойтись сама с собой: сумма столбца сходится с
 * итогом, среднее сходится с длительностью, а порог отсекает ровно то же, что отсёк бы на портале.
 * Ровно этим демо-набор и полезен: он проверяет ядро, а не только раскрашивает экран.
 *
 * ⚠ Числа не срисованы с боевого портала и никого не изображают: имена вымышленные, порядок
 * величин — правдоподобный (десятки звонков и писем на человека за месяц).
 */

/** Отделы демо-набора: дерево с узлом и двумя подотделами — чтобы фильтр было на чём показать. */
export const MOCK_DEPARTMENTS: DepartmentRef[] = [
  { id: 1, name: 'Коммерческий блок' },
  { id: 2, name: 'Отдел продаж', parentId: 1 },
  { id: 3, name: 'Отдел сопровождения', parentId: 1 }
]

/**
 * Сотрудники демо-набора.
 *
 * ⚠ Один — уволенный, и он здесь намеренно: его работа за период никуда не делась, а строка с
 * пометкой должна быть видна и в предпросмотре. Один числится в ДВУХ отделах — так на экране
 * видно, что фильтр отдела совместителя не теряет.
 */
export const MOCK_ACTIVITY_USERS: ActivityUser[] = [
  { id: 101, name: 'Ковалёва Мария', departmentIds: [2] },
  { id: 102, name: 'Дорошенко Пётр', departmentIds: [2] },
  { id: 103, name: 'Абрамчук Илья', departmentIds: [3] },
  { id: 104, name: 'Савицкая Ольга', departmentIds: [2, 3] },
  { id: 105, name: 'Микулич Егор', departmentIds: [3], dismissed: true }
]

/** Счётчики дел и лидов демо-набора — ровно те ключи, что задаёт ядро. */
export function mockActivityTotals(): Record<string, number> {
  const byUser: Record<number, { emailIn: number, emailOut: number, meeting: number, task: number, overdue: number, created: number, won: number, lost: number }> = {
    101: { emailIn: 34, emailOut: 78, meeting: 4, task: 12, overdue: 2, created: 61, won: 19, lost: 27 },
    102: { emailIn: 21, emailOut: 55, meeting: 2, task: 9, overdue: 5, created: 44, won: 12, lost: 25 },
    103: { emailIn: 47, emailOut: 30, meeting: 1, task: 21, overdue: 0, created: 12, won: 3, lost: 6 },
    104: { emailIn: 12, emailOut: 19, meeting: 6, task: 4, overdue: 1, created: 27, won: 9, lost: 11 },
    105: { emailIn: 8, emailOut: 11, meeting: 0, task: 2, overdue: 7, created: 9, won: 2, lost: 5 }
  }
  const totals: Record<string, number> = {}
  for (const [id, value] of Object.entries(byUser)) {
    const userId = Number(id)
    totals[deedKey(userId, 'email', 'in')] = value.emailIn
    totals[deedKey(userId, 'email', 'out')] = value.emailOut
    totals[deedKey(userId, 'meeting')] = value.meeting
    totals[deedKey(userId, 'task')] = value.task
    totals[overdueKey(userId)] = value.overdue
    totals[leadKey(userId, 'created')] = value.created
    totals[leadKey(userId, 'won')] = value.won
    totals[leadKey(userId, 'lost')] = value.lost
  }
  return totals
}

/**
 * Звонки демо-набора — СЫРЫМИ записями, как их отдал бы портал.
 *
 * ⚠ Числа строками, как у портала: стенд, который отдаёт числа числами, не проверяет разбор.
 * ⚠ Среди записей есть недозвоны, разговоры РОВНО в порог (они не считаются) и звонок без
 * сотрудника — то есть демо-экран показывает и строку «Без сотрудника», и все три показателя.
 */
export function mockCallRows(period: { from: string }): B24CallRow[] {
  const rows: B24CallRow[] = []
  const at = `${period.from}T10:00:00+03:00`
  /** Сколько каких звонков у кого: [исходящих, входящих, недозвонов, коротких]. */
  const plan: Record<number, [number, number, number, number]> = {
    101: [42, 18, 11, 6],
    102: [27, 31, 8, 9],
    103: [9, 24, 4, 3],
    104: [15, 7, 6, 2],
    105: [5, 3, 2, 1],
    // Звонки на общую линию, которые никто не поднял: у них сотрудника нет вовсе.
    0: [0, 0, 5, 0]
  }
  for (const [id, [out, incoming, failed, tooShort]] of Object.entries(plan)) {
    const userId = id === '0' ? '' : id
    for (let i = 0; i < out; i++) {
      rows.push({ PORTAL_USER_ID: userId, CALL_TYPE: '1', CALL_DURATION: String(45 + (i % 7) * 30), CALL_FAILED_CODE: '200', CALL_START_DATE: at })
    }
    for (let i = 0; i < incoming; i++) {
      rows.push({ PORTAL_USER_ID: userId, CALL_TYPE: '2', CALL_DURATION: String(60 + (i % 5) * 40), CALL_FAILED_CODE: '200', CALL_START_DATE: at })
    }
    for (let i = 0; i < failed; i++) {
      rows.push({ PORTAL_USER_ID: userId, CALL_TYPE: i % 2 === 0 ? '1' : '2', CALL_DURATION: '0', CALL_FAILED_CODE: '304', CALL_START_DATE: at })
    }
    for (let i = 0; i < tooShort; i++) {
      // ⚠ Ровно порог — уже не разговор: правило заказчика строгое, и демо-набор обязан его
      // показывать, иначе «короткие» на экране были бы вечным нулём.
      rows.push({ PORTAL_USER_ID: userId, CALL_TYPE: '1', CALL_DURATION: String(DEFAULT_CALL_THRESHOLD_SECONDS), CALL_FAILED_CODE: '200', CALL_START_DATE: at })
    }
  }
  return rows
}

/**
 * Готовая демо-таблица.
 *
 * @param users сотрудники, уже суженные фильтром отдела, — так предпросмотр показывает, что
 *   фильтр действительно работает, а не просто перекрашивает кнопку
 * @param departmentPicked выбран ли отдел; ⚠ БЕЗ умолчания намеренно: забытый аргумент вернул бы
 *   в таблицу звонки чужих отделов строками «Сотрудник #103», и предпросмотр разошёлся бы с
 *   боевым отчётом ровно в том, ради чего его и смотрят
 */
export function buildMockActivityReport(
  users: readonly ActivityUser[],
  period: { from: string },
  thresholdSeconds: number,
  departmentPicked: boolean
): ActivityReport {
  const calls = aggregateCalls(mockCallRows(period), { thresholdSeconds })
  // ⚠ Отдел применяется к звонкам ТОЙ ЖЕ функцией, что и на живых данных: на портале телефония
  // читается по всему порталу, и сужать её приходится после чтения. Своя копия этого правила
  // здесь однажды разошлась бы с боевой, и предпросмотр учил бы человека тому, чего в отчёте нет.
  const scoped = scopeCallsToUsers(calls, users, { departmentPicked })
  return buildActivityReport({ users, totals: mockActivityTotals(), calls: scoped, thresholdSeconds })
}
