import { describe, expect, it } from 'vitest'
import { CHART_MANAGERS_PER_COMPANY, CHART_REST_LABEL, managerChart } from '~/utils/managerChart'
import { cellKey, companyKey, COMPANY_UNSET, pairKey } from '~/utils/managerLoad'
import type { ManagerLoadReport } from '~/types/managers'

/**
 * Дерево диаграммы «Распределение». Главное свойство: числа диаграммы — ТЕ ЖЕ, что в таблице, а
 * клик по сектору открывает ровно тот список, что и число под ним. Разойтись им нельзя.
 */

const REPORT: ManagerLoadReport = {
  companies: [
    {
      companyId: 10,
      companyName: 'Минск',
      rows: [
        { managerId: 1, managerName: 'Иванов', byStage: { NEW: 2, DONE: 1 }, otherStages: 0, total: 3, share: 0.6 },
        { managerId: 2, managerName: 'Петров', byStage: { NEW: 1 }, otherStages: 0, total: 1, share: 0.2 }
      ],
      byStage: { NEW: 3, DONE: 1 },
      otherStages: 0,
      total: 5,
      unlisted: 1,
      unlistedByStage: { NEW: 1 },
      share: 0.625
    },
    {
      companyId: COMPANY_UNSET,
      companyName: 'Не указана',
      rows: [{ managerId: 1, managerName: 'Иванов', byStage: { NEW: 3 }, otherStages: 0, total: 3, share: 1 }],
      byStage: { NEW: 3 },
      otherStages: 0,
      total: 3,
      unlisted: 0,
      unlistedByStage: {},
      share: 0.375
    }
  ],
  stages: [{ id: 'NEW', name: 'Новая', semantic: 'P' }, { id: 'DONE', name: 'Готово', semantic: 'P' }],
  hiddenStages: 0,
  byStage: { NEW: 6, DONE: 1 },
  otherStages: 0,
  unlisted: 1,
  total: 8,
  managers: 2,
  companyCount: 2
}

describe('managerChart', () => {
  it('кольца: компания → менеджер → стадия', () => {
    const { nodes } = managerChart(REPORT)
    expect(nodes.map(node => node.label)).toEqual(['Минск', 'Без моей компании'])
    expect(nodes[0]!.value).toBe(5)
    const managers = nodes[0]!.children!
    expect(managers.map(node => node.value)).toEqual([3, 1, 1])
    expect(managers[0]!.children!.map(node => node.value)).toEqual([2, 1])
  })

  // ⚠ В фильтре и в заголовке списка группа зовётся «Без моей компании»: подпись «Не указана»
  // осмысленна только рядом с заголовком «Моя компания» в карточке таблицы.
  it('группу без компании называет полным именем', () => {
    const { refs } = managerChart(REPORT)
    expect(refs[companyKey(COMPANY_UNSET)]!.title).toBe('Сделки: Без моей компании')
  })

  // Ключи узлов совпадают с ключами счётчиков ядра, поэтому клик по сектору открывает тот же
  // список, что и число в таблице. Своего соответствия здесь нет — и ошибиться в нём негде.
  it('за каждым сектором стоит клетка матрицы с тем же числом', () => {
    const { refs } = managerChart(REPORT)
    expect(refs[companyKey(10)]).toEqual({ companyId: 10, title: 'Сделки: Минск', total: 5 })
    expect(refs[pairKey(10, 1)]).toEqual({ companyId: 10, managerId: 1, title: 'Сделки: Минск · Иванов', total: 3 })
    expect(refs[cellKey(10, 1, 'NEW')]).toEqual({
      companyId: 10,
      managerId: 1,
      stageId: 'NEW',
      title: 'Сделки: Минск · Иванов · Новая',
      total: 2
    })
  })

  /**
   * Сделки без строки таблицы («ответственный не найден») в кольце ЕСТЬ — местом, но без списка.
   *
   * ⚠ Выкинуть их нельзя: сумма секторов разошлась бы с числом в центре. Сделать кликабельными —
   * тоже: «ответственный не из списка» фильтром REST не выразить, и список не сошёлся бы с
   * числом, по которому нажали.
   */
  it('остаток компании занимает место в кольце, но списка за собой не имеет', () => {
    const { nodes, refs } = managerChart(REPORT)
    const rest = nodes[0]!.children!.at(-1)!
    expect(rest.label).toContain(CHART_REST_LABEL)
    expect(rest.value).toBe(1)
    expect(refs[rest.key]).toBeUndefined()
    // Дети покрывают родителя целиком: 3 + 1 + остаток 1 = 5.
    expect(nodes[0]!.children!.reduce((sum, node) => sum + node.value, 0)).toBe(nodes[0]!.value)
  })

  /**
   * ⚠ На боевом портале в направлении 70 ответственных: 70 секторов превращают кольцо в
   * штриховку, где не читается ни один. Хвост сворачивается в один сектор.
   */
  it('менеджеров в кольце не больше предела, хвост — одним сектором', () => {
    const rows = Array.from({ length: CHART_MANAGERS_PER_COMPANY + 5 }, (_, index) => ({
      managerId: index + 1,
      managerName: `Сотрудник ${index + 1}`,
      byStage: { NEW: 1 },
      otherStages: 0,
      total: 1,
      share: 0
    }))
    const { nodes } = managerChart({
      ...REPORT,
      companies: [{ ...REPORT.companies[0]!, rows, total: rows.length, unlisted: 0, unlistedByStage: {} }]
    })
    const children = nodes[0]!.children!
    expect(children).toHaveLength(CHART_MANAGERS_PER_COMPANY + 1)
    expect(children.at(-1)!.value).toBe(5)
    expect(children.at(-1)!.label).toContain(CHART_REST_LABEL)
  })

  it('пустой отчёт даёт пустое дерево, а не круг из ничего', () => {
    expect(managerChart({ ...REPORT, companies: [] }).nodes).toEqual([])
  })
})
