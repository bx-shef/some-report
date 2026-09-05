import type { CategoryRef, ManagerFilters, ManagerLoadReport, ManagerRef, OfficeRef, StageRef } from '~/types/managers'
import { buildManagerLoad, cellKey, officeKey, officeStageKey, OFFICE_UNSET, OFFICE_UNSET_LABEL, pairKey, stagesForScope, totalKey } from '~/utils/managerLoad'

/**
 * Демонстрационный набор отчёта «Сделки по менеджерам» — то, что видно вне портала (`?preview=1`).
 *
 * ⚠ Набор задан СДЕЛКАМИ, а не итогами, и это то же решение, что в отчёте по лидам. Итоги
 * считает то же ядро, что и на живых данных (`buildManagerLoad`), поэтому таблица не может
 * разойтись со сводкой над ней, а список по клику — с числом, по которому нажали. Набор из
 * готовых итогов рано или поздно расходится сам с собой — ровно этот дефект есть в макете
 * заказчика (490 000 против 485 000).
 */

/** Одна демонстрационная сделка. Полей ровно столько, сколько показывает отчёт и его список. */
export interface MockManagerDeal {
  id: number
  categoryId: number
  officeId: number
  managerId: number
  stageId: string
  title: string
  /** ISO-дата создания — по ней работает фильтр периода в предпросмотре. */
  createdAt: string
}

/** Направления демо-набора: два, чтобы фильтр направления было на чём показать. */
export const MOCK_CATEGORIES: CategoryRef[] = [
  { id: 0, name: 'Общее направление' },
  { id: 1, name: 'Оптовые продажи' }
]

/**
 * Стадии по направлениям — с разными кодами, как в портале: у направления по умолчанию коды без
 * префикса, у остальных с префиксом `C<id>:`.
 */
export const MOCK_STAGES: Record<number, StageRef[]> = {
  0: [
    { id: 'NEW', name: 'Новая', semantic: 'P' },
    { id: 'PREPARATION', name: 'Обработка', semantic: 'P' },
    { id: '1', name: 'Выставлен счёт', semantic: 'P' },
    { id: 'PROCES_DELIVERY', name: 'Отгрузка', semantic: 'P' },
    { id: 'WON', name: 'Успех', semantic: 'S' },
    { id: 'LOSE', name: 'Отказ — дорого', semantic: 'F' }
  ],
  1: [
    { id: 'C1:NEW', name: 'Новая', semantic: 'P' },
    { id: 'C1:UC_APPROVE', name: 'Согласование условий', semantic: 'P' },
    { id: 'C1:WON', name: 'Успех', semantic: 'S' },
    { id: 'C1:LOSE', name: 'Отказ — сроки поставки', semantic: 'F' }
  ]
}

/** Офисы демо-набора. Один «не указан» — на боевом портале это самая крупная строка. */
export const MOCK_OFFICES: OfficeRef[] = [
  { id: 10, name: 'ООО «Пример» — Минск' },
  { id: 20, name: 'ООО «Пример» — Гомель' },
  { id: OFFICE_UNSET, name: OFFICE_UNSET_LABEL }
]

export const MOCK_MANAGERS: ManagerRef[] = [
  { id: 101, name: 'Авдеева Мария' },
  { id: 102, name: 'Барановский Игорь' },
  { id: 103, name: 'Величко Анна' },
  { id: 104, name: 'Гончарук Павел' },
  { id: 105, name: 'Дроздова Ольга' }
]

/**
 * Сколько сделок и где. Таблица разворачивается в отдельные сделки ниже: отчёт и список по клику
 * работают со сделками, а не с этими числами.
 */
const DISTRIBUTION: Array<{ categoryId: number, officeId: number, managerId: number, stageId: string, count: number }> = [
  // Минск, направление по умолчанию
  { categoryId: 0, officeId: 10, managerId: 101, stageId: 'NEW', count: 4 },
  { categoryId: 0, officeId: 10, managerId: 101, stageId: '1', count: 7 },
  { categoryId: 0, officeId: 10, managerId: 101, stageId: 'WON', count: 5 },
  { categoryId: 0, officeId: 10, managerId: 102, stageId: 'NEW', count: 2 },
  { categoryId: 0, officeId: 10, managerId: 102, stageId: 'PREPARATION', count: 3 },
  { categoryId: 0, officeId: 10, managerId: 102, stageId: '1', count: 4 },
  { categoryId: 0, officeId: 10, managerId: 102, stageId: 'LOSE', count: 2 },
  { categoryId: 0, officeId: 10, managerId: 103, stageId: 'NEW', count: 6 },
  { categoryId: 0, officeId: 10, managerId: 103, stageId: 'PROCES_DELIVERY', count: 1 },
  // Гомель
  { categoryId: 0, officeId: 20, managerId: 104, stageId: 'NEW', count: 3 },
  { categoryId: 0, officeId: 20, managerId: 104, stageId: '1', count: 5 },
  { categoryId: 0, officeId: 20, managerId: 104, stageId: 'WON', count: 2 },
  { categoryId: 0, officeId: 20, managerId: 105, stageId: 'PREPARATION', count: 2 },
  { categoryId: 0, officeId: 20, managerId: 105, stageId: '1', count: 3 },
  // Без «моей компании» — так на портале выглядят сделки, заведённые мимо шаблона
  { categoryId: 0, officeId: OFFICE_UNSET, managerId: 101, stageId: 'NEW', count: 5 },
  { categoryId: 0, officeId: OFFICE_UNSET, managerId: 104, stageId: '1', count: 8 },
  { categoryId: 0, officeId: OFFICE_UNSET, managerId: 105, stageId: 'NEW', count: 4 },
  { categoryId: 0, officeId: OFFICE_UNSET, managerId: 105, stageId: 'LOSE', count: 3 },
  // Оптовые продажи — своё направление со своими стадиями
  { categoryId: 1, officeId: 10, managerId: 102, stageId: 'C1:NEW', count: 3 },
  { categoryId: 1, officeId: 10, managerId: 102, stageId: 'C1:UC_APPROVE', count: 4 },
  { categoryId: 1, officeId: 20, managerId: 104, stageId: 'C1:UC_APPROVE', count: 2 },
  { categoryId: 1, officeId: 20, managerId: 104, stageId: 'C1:WON', count: 1 },
  { categoryId: 1, officeId: OFFICE_UNSET, managerId: 103, stageId: 'C1:NEW', count: 2 }
]

/** Даты создания демо-сделок: разбросаны по месяцу, чтобы фильтр периода что-то менял. */
const MOCK_DAYS = ['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26', '2026-09-02']

/** Демонстрационные сделки — по одной на каждую единицу распределения. */
export function mockManagerDeals(): MockManagerDeal[] {
  const deals: MockManagerDeal[] = []
  let id = 5001
  for (const item of DISTRIBUTION) {
    for (let i = 0; i < item.count; i++) {
      deals.push({
        id: id++,
        categoryId: item.categoryId,
        officeId: item.officeId,
        managerId: item.managerId,
        stageId: item.stageId,
        title: `Демо-сделка № ${id - 1}`,
        createdAt: MOCK_DAYS[deals.length % MOCK_DAYS.length]!
      })
    }
  }
  return deals
}

/** Сделки под отбором — тот же смысл, что у фильтра REST на живом портале. */
export function filterMockDeals(deals: readonly MockManagerDeal[], filters: ManagerFilters): MockManagerDeal[] {
  const stages = MOCK_STAGES[filters.categoryId] ?? []
  const allowed = new Set(stagesForScope(stages, filters.scope).map(stage => stage.id))
  return deals.filter((deal) => {
    if (deal.categoryId !== filters.categoryId) return false
    if (!allowed.has(deal.stageId)) return false
    if (!filters.period) return true
    return deal.createdAt >= filters.period.from && deal.createdAt <= filters.period.to
  })
}

/**
 * Счётчики «как ответил бы портал» — по строкам демо-набора.
 *
 * Так предпросмотр проходит через то же ядро, что и живой отчёт: если сумма клеток разойдётся с
 * итогом строки, это увидят и тест, и человек на экране, а не только клиент на боевых данных.
 */
export function mockTotals(deals: readonly MockManagerDeal[]): Record<string, number> {
  const totals: Record<string, number> = { [totalKey()]: deals.length }
  const add = (key: string) => {
    totals[key] = (totals[key] ?? 0) + 1
  }
  for (const deal of deals) {
    add(officeKey(deal.officeId))
    // Итог колонки — такой же отдельный вопрос, как на портале: набор обязан отвечать на ВСЕ
    // вопросы, которые отчёт задаёт живому порталу, иначе предпросмотр считает по другой ветке.
    add(officeStageKey(deal.officeId, deal.stageId))
    add(pairKey(deal.officeId, deal.managerId))
    add(cellKey(deal.officeId, deal.managerId, deal.stageId))
  }
  return totals
}

/** Демонстрационный отчёт под текущим отбором. */
export function buildMockManagerReport(filters: ManagerFilters): ManagerLoadReport {
  const deals = filterMockDeals(mockManagerDeals(), filters)
  return buildManagerLoad({
    offices: MOCK_OFFICES,
    managers: MOCK_MANAGERS,
    stages: stagesForScope(MOCK_STAGES[filters.categoryId] ?? [], filters.scope),
    totals: mockTotals(deals)
  })
}
