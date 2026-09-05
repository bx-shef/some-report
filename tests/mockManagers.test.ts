import { describe, expect, it } from 'vitest'
import {
  buildMockManagerReport,
  filterMockDeals,
  MOCK_CATEGORIES,
  MOCK_STAGES,
  mockManagerDeals,
  mockTotals
} from '~/utils/mockManagers'
import { OFFICE_UNSET } from '~/utils/managerLoad'

/**
 * Демо-набор отчёта «Сделки по менеджерам». Проверяем главное свойство: он задан СДЕЛКАМИ, и
 * итоги на экране считает то же ядро, что на живом портале, — иначе предпросмотр разошёлся бы с
 * самим собой, как макет заказчика.
 */

describe('демо-набор', () => {
  const deals = mockManagerDeals()

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

  it('отбор по направлению и охвату отсекает чужие сделки', () => {
    const inWork = filterMockDeals(deals, { categoryId: 0, scope: 'in-work' })
    expect(inWork.every(d => d.categoryId === 0)).toBe(true)
    expect(inWork.some(d => d.stageId === 'WON')).toBe(false)
    const won = filterMockDeals(deals, { categoryId: 0, scope: 'won' })
    expect(won.every(d => d.stageId === 'WON')).toBe(true)
  })

  it('период отсекает сделки по дате создания', () => {
    const august = filterMockDeals(deals, { categoryId: 0, scope: 'all', period: { from: '2026-08-01', to: '2026-08-31' } })
    expect(august.length).toBeGreaterThan(0)
    expect(august.every(d => d.createdAt <= '2026-08-31')).toBe(true)
  })

  // Ровно то, ради чего набор задан сделками: сумма клеток сходится с итогом строки и офиса.
  it('итоги отчёта сходятся со сделками набора', () => {
    const filters = { categoryId: 0, scope: 'in-work' as const }
    const selected = filterMockDeals(deals, filters)
    const report = buildMockManagerReport(filters)
    expect(report.total).toBe(selected.length)
    const rowsTotal = report.offices.flatMap(o => o.rows).reduce((sum, row) => sum + row.total, 0)
    expect(rowsTotal).toBe(selected.length)
    expect(report.unlisted).toBe(0)
    expect(report.otherStages).toBe(0)
    const columns = Object.values(report.byStage).reduce((sum, value) => sum + value, 0)
    expect(columns).toBe(selected.length)
  })

  it('счётчики набора совпадают с числом сделок', () => {
    const selected = filterMockDeals(deals, { categoryId: 1, scope: 'all' })
    expect(mockTotals(selected).t).toBe(selected.length)
  })

  it('строка «моя компания не указана» в наборе есть — как на боевом портале', () => {
    const report = buildMockManagerReport({ categoryId: 0, scope: 'in-work' })
    expect(report.offices.at(-1)!.officeId).toBe(OFFICE_UNSET)
    expect(report.offices.at(-1)!.total).toBeGreaterThan(0)
  })
})
