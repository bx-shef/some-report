import { describe, expect, it } from 'vitest'
import { CHART_MANAGERS, CHART_REST_LABEL, CHART_UNLISTED_LABEL, managerChart, shortManagerName } from '~/utils/managerChart'
import { cellKey, COMPANY_UNSET, pairKey } from '~/utils/managerLoad'
import type { ManagerLoadCompany, ManagerLoadReport } from '~/types/managers'

/**
 * Дерево диаграммы «Распределение»: менеджер → стадия внутри ОДНОЙ «моей компании».
 *
 * Главное свойство: числа диаграммы — те же, что в таблице, а клик по сектору открывает ровно тот
 * список, что и число под ним. Разойтись им нельзя.
 */

const COMPANY: ManagerLoadCompany = {
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
  share: 1
}

const REPORT: ManagerLoadReport = {
  companies: [COMPANY],
  stages: [{ id: 'NEW', name: 'Новая', semantic: 'P' }, { id: 'DONE', name: 'Готово', semantic: 'P' }],
  hiddenStages: 0,
  byStage: { NEW: 3, DONE: 1 },
  otherStages: 0,
  unlisted: 1,
  total: 5,
  managers: 2,
  companyCount: 1
}

describe('managerChart', () => {
  /**
   * ⚠ Компании в кольцах НЕТ — она выбирается фильтром. Круг, поделённый между компаниями,
   * отдавал одной почти всё (на боевом портале 599 сделок против одной), и менеджеры сжимались
   * в неразличимую штриховку по краю.
   */
  it('кольца: менеджер → стадия, компании среди корней нет', () => {
    const { nodes } = managerChart(REPORT, COMPANY)
    expect(nodes.map(node => node.label)).toEqual(['Иванов', 'Петров', CHART_UNLISTED_LABEL])
    expect(nodes[0]!.value).toBe(3)
    expect(nodes[0]!.children!.map(node => [node.label, node.value])).toEqual([['Новая', 2], ['Готово', 1]])
  })

  // Ключи узлов совпадают с ключами счётчиков ядра, поэтому клик по сектору открывает тот же
  // список, что и число в таблице. Своего соответствия здесь нет — и ошибиться в нём негде.
  it('за каждым сектором стоит клетка матрицы с тем же числом', () => {
    const { refs } = managerChart(REPORT, COMPANY)
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
   * Сделки без ответственного в кольце ЕСТЬ — местом, но без списка.
   *
   * ⚠ Выкинуть их нельзя: сумма секторов разошлась бы с числом в центре. Сделать кликабельными —
   * тоже: «ответственный не из списка» фильтром REST не выразить, и список не сошёлся бы с
   * числом, по которому нажали.
   */
  it('сделки без ответственного занимают место в кольце, но списка за собой не имеют', () => {
    const { nodes, refs } = managerChart(REPORT, COMPANY)
    const unlisted = nodes.at(-1)!
    expect(unlisted.label).toBe(CHART_UNLISTED_LABEL)
    expect(unlisted.value).toBe(1)
    expect(refs[unlisted.key]).toBeUndefined()
    // Сумма секторов равна итогу компании: 3 + 1 + 1.
    expect(nodes.reduce((sum, node) => sum + node.value, 0)).toBe(COMPANY.total)
  })

  /**
   * ⚠ На боевом портале в направлении тридцать ответственных, и у половины сделок единицы: их
   * сектора превращают кольцо в штриховку, где не читается ни один.
   */
  it('менеджеров в кольце не больше предела, хвост — одним сектором', () => {
    const rows = Array.from({ length: CHART_MANAGERS + 5 }, (_, index) => ({
      managerId: index + 1,
      managerName: `Сотрудник ${index + 1}`,
      byStage: { NEW: 1 },
      otherStages: 0,
      total: 1,
      share: 0
    }))
    const company = { ...COMPANY, rows, total: rows.length, unlisted: 0, unlistedByStage: {} }
    const { nodes } = managerChart({ ...REPORT, companies: [company] }, company)
    expect(nodes).toHaveLength(CHART_MANAGERS + 1)
    expect(nodes.at(-1)!.label).toBe(CHART_REST_LABEL)
    expect(nodes.at(-1)!.value).toBe(5)
  })

  /**
   * ⚠ Заголовок списка берёт `companyFullLabel` — ТОТ ЖЕ, что и таблица. У группы без «моей
   * компании» подписи две: «Не указана» в таблице и легенде (там рядом стоит заголовок про «мою
   * компанию») и «Без моей компании» в заголовке списка, где такого заголовка нет. Возьми
   * диаграмма голое `companyName` — одно и то же число открывало бы список с разными
   * заголовками в зависимости от того, где по нему нажали.
   */
  it('группу без «моей компании» в заголовке списка называет полным именем', () => {
    const company = { ...COMPANY, companyId: COMPANY_UNSET, companyName: 'Не указана' }
    const { refs } = managerChart({ ...REPORT, companies: [company] }, company)
    expect(refs[pairKey(COMPANY_UNSET, 1)]!.title).toBe('Сделки: Без моей компании · Иванов')
  })

  /**
   * Кольцо рисует первых, легенда — ВСЕХ, и её числа обязаны открывать список так же, как числа
   * таблицы. ⚠ Раньше легенда искала ссылку по номеру строки и на тринадцатом менеджере молча
   * попадала в сектор «Остальные», у которого ссылки нет: половина строк переставала быть
   * кликабельной, хотя те же числа в таблице открывались.
   */
  it('ссылка на список есть у КАЖДОГО менеджера, даже если сектора ему не досталось', () => {
    const rows = Array.from({ length: CHART_MANAGERS + 3 }, (_, index) => ({
      managerId: index + 1,
      managerName: `Сотрудник ${index + 1}`,
      byStage: { NEW: 1 },
      otherStages: 0,
      total: 1,
      share: 0
    }))
    const company = { ...COMPANY, rows, total: rows.length, unlisted: 0, unlistedByStage: {} }
    const { nodes, refs } = managerChart({ ...REPORT, companies: [company] }, company)
    const last = rows.at(-1)!
    expect(nodes.some(node => node.label === last.managerName)).toBe(false)
    expect(refs[pairKey(10, last.managerId)]).toEqual({
      companyId: 10,
      managerId: last.managerId,
      title: `Сделки: Минск · ${last.managerName}`,
      total: 1
    })
  })

  it('без компании дерево пустое, а не круг из ничего', () => {
    expect(managerChart(REPORT, undefined).nodes).toEqual([])
  })

  /**
   * ⚠ В секторе — «Фамилия И.», а не обрезанная по длине строка: «Авдеева …» и «Авдеенко …» на
   * соседних секторах выглядели бы одинаково, а это разные люди. Полное имя остаётся в подсказке,
   * в легенде и в таблице.
   */
  it.each([
    ['Авдеева Мария', 'Авдеева М.'],
    ['Барановский Игорь Петрович', 'Барановский И.'],
    ['Ярец', 'Ярец'],
    ['  Шут   Дмитрий  ', 'Шут Д.'],
    // ⚠ Так подписан уволенный, которого `user.get` уже не отдаёт, — случай для этого отчёта
    // штатный. Общее правило схлопнуло бы всех таких в «Сотрудник #.», то есть сделало бы
    // неразличимыми ровно тех, кого различить и надо. Обрежет такую подпись сама диаграмма.
    ['Сотрудник #5562', 'Сотрудник #5562'],
    ['', '']
  ])('подпись сектора для «%s» — «%s»', (full, short) => {
    expect(shortManagerName(full)).toBe(short)
  })
})
