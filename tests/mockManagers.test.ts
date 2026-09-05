import { describe, expect, it } from 'vitest'
import {
  buildMockManagerReport,
  filterMockDeals,
  MOCK_CATEGORIES,
  MOCK_STAGES,
  mockManagerDeals,
  mockTotals
} from '~/utils/mockManagers'
import { COMPANY_UNSET } from '~/utils/managerLoad'

/**
 * Демо-набор отчёта «Сделки по менеджерам». Проверяем главное свойство: он задан СДЕЛКАМИ, и
 * итоги на экране считает то же ядро, что на живом портале, — иначе предпросмотр разошёлся бы с
 * самим собой, как макет заказчика.
 */

describe('демо-набор', () => {
  /**
   * «Сегодня» задано днём: даты набора считаются от него.
   *
   * ⚠ Так и должно быть. Умолчание отчёта — текущий месяц, и набор с датами прошлого года под
   * этим умолчанием показывал бы пустой экран: предпросмотр читался бы как сломанный отчёт.
   */
  const TODAY = new Date(2026, 8, 15)
  const MONTH = { from: '2026-09-01', to: '2026-09-30' }
  const deals = mockManagerDeals(TODAY)

  it('у каждого направления свой набор стадий', () => {
    for (const category of MOCK_CATEGORIES) expect(MOCK_STAGES[category.id]!.length).toBeGreaterThan(0)
    // Коды не пересекаются: в портале у каждого направления свои, с префиксом `C<id>:`.
    const zero = new Set(MOCK_STAGES[0]!.map(s => s.id))
    expect(MOCK_STAGES[1]!.every(s => !zero.has(s.id))).toBe(true)
  })

  it('каждая сделка стоит на стадии своего направления', () => {
    for (const deal of deals) {
      expect(MOCK_STAGES[deal.categoryId]!.map(s => s.id)).toContain(deal.stageId)
    }
  })

  // Даты внутри текущего месяца: под умолчанием отчёта предпросмотр показывает весь набор, а не
  // пустой экран.
  it('сделки созданы в текущем месяце «сегодня»', () => {
    expect(deals.every(deal => deal.createdAt >= MONTH.from && deal.createdAt <= '2026-09-15')).toBe(true)
    expect(filterMockDeals(deals, { categoryId: 0, scope: 'all', period: MONTH }).length).toBeGreaterThan(0)
  })

  it('отбор по направлению и охвату отсекает чужие сделки', () => {
    const inWork = filterMockDeals(deals, { categoryId: 0, scope: 'in-work', period: MONTH })
    expect(inWork.every(d => d.categoryId === 0)).toBe(true)
    expect(inWork.some(d => d.stageId === 'WON')).toBe(false)
    const won = filterMockDeals(deals, { categoryId: 0, scope: 'won', period: MONTH })
    expect(won.every(d => d.stageId === 'WON')).toBe(true)
  })

  it('период отсекает сделки по дате создания', () => {
    const august = filterMockDeals(deals, { categoryId: 0, scope: 'all', period: { from: '2026-08-01', to: '2026-08-31' } })
    expect(august).toEqual([])
    const firstDays = filterMockDeals(deals, { categoryId: 0, scope: 'all', period: { from: '2026-09-01', to: '2026-09-03' } })
    expect(firstDays.length).toBeGreaterThan(0)
    expect(firstDays.every(d => d.createdAt <= '2026-09-03')).toBe(true)
  })

  // ⚠ Ноль — это «Без моей компании», а не «все»: в предпросмотре фильтр обязан работать так же,
  // как фильтр REST на живом портале.
  it('фильтр компании отбирает её сделки, ноль — сделки без компании', () => {
    const minsk = filterMockDeals(deals, { categoryId: 0, scope: 'all', period: MONTH, companyId: 10 })
    expect(minsk.length).toBeGreaterThan(0)
    expect(minsk.every(d => d.companyId === 10)).toBe(true)
    const unset = filterMockDeals(deals, { categoryId: 0, scope: 'all', period: MONTH, companyId: COMPANY_UNSET })
    expect(unset.length).toBeGreaterThan(0)
    expect(unset.every(d => d.companyId === COMPANY_UNSET)).toBe(true)
  })

  // Ровно то, ради чего набор задан сделками: сумма клеток сходится с итогом строки и компании.
  it('итоги отчёта сходятся со сделками набора', () => {
    const filters = { categoryId: 0, scope: 'in-work' as const, period: MONTH }
    const selected = filterMockDeals(deals, filters)
    const report = buildMockManagerReport(filters, TODAY)
    expect(report.total).toBe(selected.length)
    const rowsTotal = report.companies.flatMap(o => o.rows).reduce((sum, row) => sum + row.total, 0)
    expect(rowsTotal).toBe(selected.length)
    expect(report.unlisted).toBe(0)
    expect(report.otherStages).toBe(0)
    const columns = Object.values(report.byStage).reduce((sum, value) => sum + value, 0)
    expect(columns).toBe(selected.length)
  })

  it('счётчики набора совпадают с числом сделок', () => {
    const selected = filterMockDeals(deals, { categoryId: 1, scope: 'all', period: MONTH })
    expect(mockTotals(selected).t).toBe(selected.length)
  })

  // Группа «Не указана» в наборе есть — как на боевом портале. Особого места в порядке у неё
  // больше нет (решение владельца от 2026-09-05): сортируется по числу сделок, как все.
  it('группа «без моей компании» в наборе есть и стоит в общем порядке', () => {
    const report = buildMockManagerReport({ categoryId: 0, scope: 'in-work', period: MONTH }, TODAY)
    const unset = report.companies.find(company => company.companyId === COMPANY_UNSET)
    expect(unset?.total).toBeGreaterThan(0)
    expect(report.companies.map(company => company.total)).toEqual([...report.companies.map(company => company.total)].sort((a, b) => b - a))
  })
})
