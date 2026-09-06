import { describe, expect, it } from 'vitest'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import { NO_USER_LABEL, totalCalls, usersInDepartment } from '~/utils/activityLoad'
import { MOCK_ACTIVITY_USERS, MOCK_DEPARTMENTS, buildMockActivityReport, mockCallRows } from '~/utils/mockActivity'

/**
 * Демонстрационный набор отчёта «Активность пользователей».
 *
 * ⚠ Проверяем не «числа те же, что вчера», а СХОДИМОСТЬ: демо-набор задан сырыми записями, итоги
 * считает то же ядро, что и на живых данных, — и разойтись между собой они не могут. Именно это и
 * делает демо-экран полезным: он проверяет ядро, а не раскрашивает картинку.
 */

const period = { from: '2026-08-01', to: '2026-08-31' }

describe('buildMockActivityReport', () => {
  const report = buildMockActivityReport(MOCK_ACTIVITY_USERS, period, DEFAULT_CALL_THRESHOLD_SECONDS, false)

  it('итог сходится с суммой строк', () => {
    const sum = report.rows.reduce((acc, row) => acc + totalCalls(row).count, 0)
    expect(sum).toBe(totalCalls(report.totals).count)
    const seconds = report.rows.reduce((acc, row) => acc + totalCalls(row).seconds, 0)
    expect(seconds).toBe(totalCalls(report.totals).seconds)
    const emails = report.rows.reduce((acc, row) => acc + row.deeds.email.out, 0)
    expect(emails).toBe(report.totals.deeds.email.out)
  })

  /** Демо-экран обязан показывать ВСЕ показатели, иначе он не показывает отчёт. */
  it('на экране есть и недозвоны, и короткие разговоры, и обе стороны звонка', () => {
    expect(report.totals.failed).toBeGreaterThan(0)
    expect(report.totals.tooShort).toBeGreaterThan(0)
    expect(report.totals.calls.in.count).toBeGreaterThan(0)
    expect(report.totals.calls.out.count).toBeGreaterThan(0)
    expect(report.totals.deeds.overdue).toBeGreaterThan(0)
    expect(report.totals.leads.won).toBeGreaterThan(0)
  })

  /** ⚠ Строка «Без сотрудника» — не выдумка: у заказчика это звонки на общую линию. */
  it('есть строка звонков без сотрудника и строка уволенного', () => {
    expect(report.rows.some(row => row.userName === NO_USER_LABEL)).toBe(true)
    expect(report.rows.some(row => row.dismissed)).toBe(true)
  })

  /** Демо-набор — это данные, а не итоги: звонки в нём настоящие записи. */
  it('звонки заданы записями, а не числами', () => {
    const rows = mockCallRows(period)
    expect(rows.length).toBeGreaterThan(100)
    // Портал отдаёт числа СТРОКАМИ — стенд обязан вести себя так же.
    expect(typeof rows[0]?.CALL_DURATION).toBe('string')
    expect(typeof rows[0]?.CALL_TYPE).toBe('string')
  })

  /** ⚠ Порог в демо-наборе действует так же, как на портале: разговоры РОВНО в порог не считаются. */
  it('порог меняет числа демо-набора, а не только подпись', () => {
    const strict = buildMockActivityReport(MOCK_ACTIVITY_USERS, period, 600, false)
    expect(strict.thresholdSeconds).toBe(600)
    expect(totalCalls(strict.totals).count).toBeLessThan(totalCalls(report.totals).count)
    // Ни один звонок не потерялся: он просто переехал в «короткие».
    const before = totalCalls(report.totals).count + report.totals.tooShort
    const after = totalCalls(strict.totals).count + strict.totals.tooShort
    expect(after).toBe(before)
  })

  /**
   * ⚠ Фильтр отдела в предпросмотре обязан РАБОТАТЬ, а не перекрашивать кнопку: иначе демо-экран
   * учит человека тому, чего в отчёте нет.
   */
  it('фильтр отдела сужает демо-таблицу и не возвращает чужих через звонки', () => {
    const inSales = usersInDepartment(MOCK_ACTIVITY_USERS, MOCK_DEPARTMENTS, 2)
    const scoped = buildMockActivityReport(inSales, period, DEFAULT_CALL_THRESHOLD_SECONDS, true)
    expect(scoped.rows.map(row => row.userId).sort()).toEqual(inSales.map(user => user.id).sort())
    // ⚠ Строки «Без сотрудника» под выбранным отделом тоже нет: ничьи звонки ни к какому отделу
    // не относятся.
    expect(scoped.rows.some(row => row.userName === NO_USER_LABEL)).toBe(false)
    // Ни одной строки «Сотрудник #103»: звонки не своих в выборку не попадают.
    expect(scoped.rows.some(row => /^Сотрудник #/.test(row.userName))).toBe(false)
  })

  /** ⚠ Отдел берётся с подотделами: «Коммерческий блок» — это оба отдела под ним. */
  it('узел дерева даёт всех, кто под ним', () => {
    expect(usersInDepartment(MOCK_ACTIVITY_USERS, MOCK_DEPARTMENTS, 1)).toHaveLength(MOCK_ACTIVITY_USERS.length)
  })
})
