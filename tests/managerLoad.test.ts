import { describe, expect, it } from 'vitest'
import type { StageRef } from '~/types/managers'
import {
  buildManagerLoad,
  cellKey,
  emptyManagerLoad,
  companyKey,
  COMPANY_UNSET,
  COMPANY_UNSET_LABEL,
  companyStageKey,
  pairKey,
  scopeSemantic,
  stageCountSeconds,
  stagesForScope,
  totalKey
} from '~/utils/managerLoad'

/**
 * Ядро отчёта «Сделки по менеджерам». Проверяем не «складывается ли», а то, что ломается молча:
 * порядок строк, остатки при несходящихся счётчиках и место строки «моя компания не указана».
 */

const STAGES: StageRef[] = [
  { id: 'NEW', name: 'Новая', semantic: 'P' },
  { id: '1', name: 'Выставлен счет', semantic: 'P' },
  { id: 'WON', name: 'Успех', semantic: 'S' },
  { id: 'LOSE', name: 'Отказ', semantic: 'F' }
]

const COMPANIES = [
  { id: 10, name: 'Минск' },
  { id: 20, name: 'Гомель' },
  { id: COMPANY_UNSET, name: COMPANY_UNSET_LABEL }
]

const MANAGERS = [
  { id: 1, name: 'Иванов Иван' },
  { id: 2, name: 'Петров Пётр' },
  { id: 3, name: 'Сидоров Сидор' }
]

/** Счётчики «как из портала»: итог, итоги компаний, пары, клетки. */
function totals(entries: Record<string, number>): Record<string, number> {
  return entries
}

describe('scopeSemantic и stagesForScope', () => {
  it('охват превращается в семантику стадии портала', () => {
    expect(scopeSemantic('in-work')).toBe('P')
    expect(scopeSemantic('won')).toBe('S')
    expect(scopeSemantic('lost')).toBe('F')
    expect(scopeSemantic('all')).toBeUndefined()
  })

  it('колонки берутся по семантике справочника, а не по кодам стадий', () => {
    expect(stagesForScope(STAGES, 'in-work').map(s => s.id)).toEqual(['NEW', '1'])
    expect(stagesForScope(STAGES, 'won').map(s => s.id)).toEqual(['WON'])
    expect(stagesForScope(STAGES, 'all')).toHaveLength(4)
  })
})

describe('buildManagerLoad', () => {
  const input = {
    companies: COMPANIES,
    managers: MANAGERS,
    stages: stagesForScope(STAGES, 'in-work'),
    totals: totals({
      [totalKey()]: 30,
      [companyKey(10)]: 20,
      [companyKey(20)]: 10,
      [companyKey(COMPANY_UNSET)]: 0,
      [pairKey(10, 1)]: 12,
      [pairKey(10, 2)]: 8,
      [pairKey(20, 3)]: 10,
      [cellKey(10, 1, 'NEW')]: 5,
      [cellKey(10, 1, '1')]: 7,
      [cellKey(10, 2, 'NEW')]: 8,
      [cellKey(20, 3, '1')]: 10
    })
  }

  it('строит матрицу компания → менеджер → стадия', () => {
    const report = buildManagerLoad(input)
    expect(report.total).toBe(30)
    expect(report.managers).toBe(3)
    expect(report.companyCount).toBe(2)
    expect(report.companies[0]!.companyName).toBe('Минск')
    expect(report.companies[0]!.rows.map(r => r.managerName)).toEqual(['Иванов Иван', 'Петров Пётр'])
    expect(report.companies[0]!.rows[0]!.byStage).toEqual({ NEW: 5, 1: 7 })
    expect(report.byStage).toEqual({ NEW: 13, 1: 17 })
  })

  it('компания без сделок в таблицу не попадает', () => {
    const report = buildManagerLoad(input)
    expect(report.companies.map(o => o.companyId)).toEqual([10, 20])
  })

  it('строки — по числу сделок вниз, доли считаются от итога компании', () => {
    const report = buildManagerLoad(input)
    const company = report.companies[0]!
    expect(company.rows[0]!.total).toBe(12)
    expect(company.rows[0]!.share).toBeCloseTo(12 / 20)
    expect(company.share).toBeCloseTo(20 / 30)
  })

  it('пустые колонки скрываются, и отчёт говорит сколько', () => {
    const report = buildManagerLoad({
      ...input,
      stages: [...input.stages, { id: 'EXTRA', name: 'Пустая', semantic: 'P' }]
    })
    expect(report.stages.map(s => s.id)).toEqual(['NEW', '1'])
    expect(report.hiddenStages).toBe(1)
  })

  // Сделки уволенного или неназначенные в строки не попадают: перечисление идёт по
  // ответственным, а их у таких сделок нет. Разница обязана быть видна числом, а не потеряться.
  it('итог компании больше суммы строк — разница показана остатком', () => {
    const report = buildManagerLoad({
      ...input,
      totals: { ...input.totals, [companyKey(10)]: 25 }
    })
    const company = report.companies.find(o => o.companyId === 10)!
    expect(company.total).toBe(25)
    expect(company.unlisted).toBe(5)
    expect(report.unlisted).toBe(5)
  })

  // Стадию удалили из справочника, а сделки на ней остались: сумма колонок меньше итога пары.
  it('сделки на стадии вне справочника — остаток строки, а не потеря', () => {
    const report = buildManagerLoad({
      ...input,
      totals: { ...input.totals, [cellKey(10, 1, '1')]: 4 }
    })
    const row = report.companies[0]!.rows[0]!
    expect(row.total).toBe(12)
    expect(row.otherStages).toBe(3)
    expect(report.otherStages).toBe(3)
  })

  // Счётчики приходят разными пакетами: между ними портал живёт, и сумма строк может обогнать
  // итог компании. Отрицательного остатка быть не должно ни при каких данных.
  it('сумма строк больше итога компании — остаток ноль, а не минус', () => {
    const report = buildManagerLoad({
      ...input,
      totals: { ...input.totals, [companyKey(10)]: 3, [totalKey()]: 3 }
    })
    const company = report.companies.find(o => o.companyId === 10)!
    expect(company.total).toBe(20)
    expect(company.unlisted).toBe(0)
    expect(report.total).toBe(30)
    expect(report.unlisted).toBe(0)
  })

  // ⚠ Решение владельца от 2026-09-05: «Не указана» — такая же группа, как остальные, и место в
  // порядке у неё общее — по числу сделок. Раньше она всегда стояла последней как «незаполненное
  // поле»; теперь выбор «смотреть её или нет» отдан фильтру «Моя компания» в панели, и отдельное
  // место в сортировке означало бы, что отчёт спорит с только что выставленным фильтром.
  it('«без моей компании» сортируется по числу сделок, как все', () => {
    const report = buildManagerLoad({
      ...input,
      totals: {
        ...input.totals,
        [totalKey()]: 130,
        [companyKey(COMPANY_UNSET)]: 100,
        [pairKey(COMPANY_UNSET, 1)]: 100,
        [cellKey(COMPANY_UNSET, 1, 'NEW')]: 100
      }
    })
    expect(report.companies.map(o => o.companyId)).toEqual([COMPANY_UNSET, 10, 20])
    expect(report.companies[0]!.total).toBe(100)
  })

  it('без счётчиков — пустой отчёт, а не деление на ноль', () => {
    const report = buildManagerLoad({ ...input, totals: {} })
    expect(report).toEqual(emptyManagerLoad())
  })
})

describe('итоги колонок — счётчики портала, а не суммы клеток', () => {
  const base = {
    companies: COMPANIES,
    managers: MANAGERS,
    stages: stagesForScope(STAGES, 'in-work'),
    totals: totals({
      [totalKey()]: 30,
      [companyKey(10)]: 25,
      [pairKey(10, 1)]: 12,
      [cellKey(10, 1, 'NEW')]: 5,
      [cellKey(10, 1, '1')]: 7,
      // Итоги колонок больше суммы клеток ровно на сделки без ответственного (25 − 12 = 13).
      [companyStageKey(10, 'NEW')]: 8,
      [companyStageKey(10, '1')]: 17
    })
  }

  // Ровно та причина, по которой колонка спрашивается отдельно: клик по её итогу открывает
  // список по «компания + стадия», и число обязано совпадать с длиной этого списка.
  it('итог колонки берётся из счётчика, даже если он больше суммы строк', () => {
    const company = buildManagerLoad(base).companies[0]!
    expect(company.byStage).toEqual({ NEW: 8, 1: 17 })
    expect(company.total).toBe(25)
  })

  it('разница раскладывается в строку «вне таблицы» по стадиям', () => {
    const company = buildManagerLoad(base).companies[0]!
    expect(company.unlisted).toBe(13)
    expect(company.unlistedByStage).toEqual({ NEW: 3, 1: 10 })
  })

  it('сошлось: колонки плюс прочие стадии равны итогу компании', () => {
    const company = buildManagerLoad(base).companies[0]!
    const columns = Object.values(company.byStage).reduce((sum, value) => sum + value, 0)
    expect(columns + company.otherStages).toBe(company.total)
  })

  // Стадии считаются по кнопке: колонок нет вовсе, и «прочими» не может стать вся таблица.
  it('без колонок остатков по стадиям нет', () => {
    const report = buildManagerLoad({ ...base, stages: [] })
    expect(report.stages).toEqual([])
    expect(report.otherStages).toBe(0)
    expect(report.companies[0]!.rows[0]!.otherStages).toBe(0)
    expect(report.companies[0]!.total).toBe(25)
  })
})

describe('остатки уровня отчёта', () => {
  // Компания не перечислился (цепочка упёрлась в предел): его сделки есть в общем итоге, но ни в
  // одной строке. Молчать о них нельзя — это те же «сделки вне таблицы».
  it('сделки компании, которого нет в списке, попадают в общий остаток', () => {
    const report = buildManagerLoad({
      companies: [{ id: 10, name: 'Минск' }],
      managers: MANAGERS,
      stages: stagesForScope(STAGES, 'in-work'),
      totals: totals({
        [totalKey()]: 50,
        [companyKey(10)]: 20,
        [pairKey(10, 1)]: 20,
        [cellKey(10, 1, 'NEW')]: 20
      })
    })
    expect(report.total).toBe(50)
    expect(report.unlisted).toBe(30)
  })
})

describe('порядок при равных числах', () => {
  // Иначе строки прыгали бы между обновлениями, и человек читал бы это как «данные меняются».
  it('равные итоги сортируются по имени', () => {
    const report = buildManagerLoad({
      companies: [{ id: 10, name: 'Минск' }],
      managers: [{ id: 1, name: 'Яковлев Ян' }, { id: 2, name: 'Абрамов Абрам' }],
      stages: stagesForScope(STAGES, 'in-work'),
      totals: totals({
        [totalKey()]: 10,
        [companyKey(10)]: 10,
        [pairKey(10, 1)]: 5,
        [pairKey(10, 2)]: 5
      })
    })
    expect(report.companies[0]!.rows.map(row => row.managerName)).toEqual(['Абрамов Абрам', 'Яковлев Ян'])
  })
})

describe('stageCountSeconds', () => {
  // По этой оценке экран обещает время ожидания — обещание должно быть не оптимистичнее замера.
  it('считает по пакетам, а не по клеткам', () => {
    expect(stageCountSeconds(0)).toBe(0)
    expect(stageCountSeconds(50)).toBe(2)
    expect(stageCountSeconds(51)).toBe(4)
    expect(stageCountSeconds(3000)).toBe(120)
  })
})
