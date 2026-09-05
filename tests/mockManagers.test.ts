import { describe, expect, it } from 'vitest'
import {
  buildMockManagerReport,
  mockCompanyTotals,
  pickLargestMockCompany,
  filterMockDeals,
  MOCK_COMPANIES,
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

  /**
   * Ровно то, ради чего набор задан сделками: сумма клеток сходится с итогом строки и компании.
   *
   * ⚠ Компания на экране ОДНА (решение владельца от 2026-09-05), поэтому и сверяем с её сделками,
   * а не со всеми: отчёт показывает выбранную компанию, а не сумму по портфелю.
   */
  it('итоги отчёта сходятся со сделками набора', () => {
    const base = { categoryId: 0, scope: 'in-work' as const, period: MONTH }
    const filters = { ...base, companyId: pickLargestMockCompany(deals, base) }
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

  // Группа «Не указана» в наборе есть — как на боевом портале, и открывается такой же кнопкой
  // фильтра, как любая компания.
  it('группу «без моей компании» можно открыть фильтром', () => {
    const report = buildMockManagerReport({ categoryId: 0, scope: 'in-work', period: MONTH, companyId: COMPANY_UNSET }, TODAY)
    expect(report.companies.map(company => company.companyId)).toEqual([COMPANY_UNSET])
    expect(report.total).toBeGreaterThan(0)
  })

  /**
   * ⚠ Компания на экране ОДНА. Не выбрана — берём самую крупную: показывать «всё сразу» нельзя,
   * иначе предпросмотр показывал бы устройство экрана, которого в портале не бывает.
   */
  it('без выбора компании отчёт открывает самую крупную', () => {
    const filters = { categoryId: 0, scope: 'in-work' as const, period: MONTH }
    const report = buildMockManagerReport(filters, TODAY)
    expect(report.companies).toHaveLength(1)
    expect(report.companies[0]!.companyId).toBe(pickLargestMockCompany(deals, filters))
  })
})

/**
 * Числа на кнопках фильтра «Моя компания» и выбор компании, которую отчёт открывает сам.
 *
 * ⚠ Обе функции держат ИНТЕРФЕЙС предпросмотра: без них демо-страница показывала бы кнопки без
 * чисел и ни одной подсвеченной — то есть учила бы человека экрану, которого в портале нет.
 */
describe('кнопки фильтра «Моя компания» в предпросмотре', () => {
  const TODAY = new Date(2026, 8, 15)
  const BASE = { categoryId: 0, scope: 'all' as const, period: { from: '2026-09-01', to: '2026-09-30' } }

  it('число на кнопке — это ровно столько сделок, сколько покажет сама кнопка', () => {
    const deals = mockManagerDeals(TODAY)
    const totals = mockCompanyTotals(deals, BASE)
    // Ключ есть у каждой компании набора, включая «Без моей компании»: ноль там — ЗНАЧЕНИЕ.
    expect(Object.keys(totals).map(Number).sort((a, b) => a - b))
      .toEqual(MOCK_COMPANIES.map(company => company.id).sort((a, b) => a - b))
    for (const company of MOCK_COMPANIES) {
      expect(totals[company.id], company.name)
        .toBe(filterMockDeals(deals, { ...BASE, companyId: company.id }).length)
    }
  })

  it('сумма кнопок равна всем сделкам отбора: ни одна не потерялась и ни одна не сосчитана дважды', () => {
    const deals = mockManagerDeals(TODAY)
    const totals = mockCompanyTotals(deals, BASE)
    expect(Object.values(totals).reduce((sum, value) => sum + value, 0))
      .toBe(filterMockDeals(deals, BASE).length)
  })

  it('сам отчёт открывает самую крупную компанию', () => {
    const deals = mockManagerDeals(TODAY)
    const totals = mockCompanyTotals(deals, BASE)
    const picked = pickLargestMockCompany(deals, BASE)
    for (const company of MOCK_COMPANIES) {
      expect(totals[picked]!).toBeGreaterThanOrEqual(totals[company.id]!)
    }
  })

  /**
   * ⚠ Пустой отбор — норма этого отчёта, а не сбой: период выбирают вперёд, в него ещё ничего не
   * создано. Компанию всё равно надо назвать, иначе экрану нечего показывать и нечего подсветить.
   */
  it('под пустым отбором компания всё равно выбирается', () => {
    const deals = mockManagerDeals(TODAY)
    const empty = { ...BASE, period: { from: '2027-01-01', to: '2027-01-31' } }
    expect(Object.values(mockCompanyTotals(deals, empty))).toEqual([0, 0, 0])
    expect(MOCK_COMPANIES.some(company => company.id === pickLargestMockCompany(deals, empty))).toBe(true)
  })
})
