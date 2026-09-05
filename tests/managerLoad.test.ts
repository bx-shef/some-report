import { describe, expect, it } from 'vitest'
import type { StageRef } from '~/types/managers'
import {
  buildManagerLoad,
  cellKey,
  emptyManagerLoad,
  officeKey,
  OFFICE_UNSET,
  OFFICE_UNSET_LABEL,
  officeStageKey,
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

const OFFICES = [
  { id: 10, name: 'Минск' },
  { id: 20, name: 'Гомель' },
  { id: OFFICE_UNSET, name: OFFICE_UNSET_LABEL }
]

const MANAGERS = [
  { id: 1, name: 'Иванов Иван' },
  { id: 2, name: 'Петров Пётр' },
  { id: 3, name: 'Сидоров Сидор' }
]

/** Счётчики «как из портала»: итог, итоги офисов, пары, клетки. */
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
    offices: OFFICES,
    managers: MANAGERS,
    stages: stagesForScope(STAGES, 'in-work'),
    totals: totals({
      [totalKey()]: 30,
      [officeKey(10)]: 20,
      [officeKey(20)]: 10,
      [officeKey(OFFICE_UNSET)]: 0,
      [pairKey(10, 1)]: 12,
      [pairKey(10, 2)]: 8,
      [pairKey(20, 3)]: 10,
      [cellKey(10, 1, 'NEW')]: 5,
      [cellKey(10, 1, '1')]: 7,
      [cellKey(10, 2, 'NEW')]: 8,
      [cellKey(20, 3, '1')]: 10
    })
  }

  it('строит матрицу офис → менеджер → стадия', () => {
    const report = buildManagerLoad(input)
    expect(report.total).toBe(30)
    expect(report.managers).toBe(3)
    expect(report.officeCount).toBe(2)
    expect(report.offices[0]!.officeName).toBe('Минск')
    expect(report.offices[0]!.rows.map(r => r.managerName)).toEqual(['Иванов Иван', 'Петров Пётр'])
    expect(report.offices[0]!.rows[0]!.byStage).toEqual({ NEW: 5, 1: 7 })
    expect(report.byStage).toEqual({ NEW: 13, 1: 17 })
  })

  it('офис без сделок в таблицу не попадает', () => {
    const report = buildManagerLoad(input)
    expect(report.offices.map(o => o.officeId)).toEqual([10, 20])
  })

  it('строки — по числу сделок вниз, доли считаются от итога офиса', () => {
    const report = buildManagerLoad(input)
    const office = report.offices[0]!
    expect(office.rows[0]!.total).toBe(12)
    expect(office.rows[0]!.share).toBeCloseTo(12 / 20)
    expect(office.share).toBeCloseTo(20 / 30)
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
  it('итог офиса больше суммы строк — разница показана остатком', () => {
    const report = buildManagerLoad({
      ...input,
      totals: { ...input.totals, [officeKey(10)]: 25 }
    })
    const office = report.offices.find(o => o.officeId === 10)!
    expect(office.total).toBe(25)
    expect(office.unlisted).toBe(5)
    expect(report.unlisted).toBe(5)
  })

  // Стадию удалили из справочника, а сделки на ней остались: сумма колонок меньше итога пары.
  it('сделки на стадии вне справочника — остаток строки, а не потеря', () => {
    const report = buildManagerLoad({
      ...input,
      totals: { ...input.totals, [cellKey(10, 1, '1')]: 4 }
    })
    const row = report.offices[0]!.rows[0]!
    expect(row.total).toBe(12)
    expect(row.otherStages).toBe(3)
    expect(report.otherStages).toBe(3)
  })

  // Счётчики приходят разными пакетами: между ними портал живёт, и сумма строк может обогнать
  // итог офиса. Отрицательного остатка быть не должно ни при каких данных.
  it('сумма строк больше итога офиса — остаток ноль, а не минус', () => {
    const report = buildManagerLoad({
      ...input,
      totals: { ...input.totals, [officeKey(10)]: 3, [totalKey()]: 3 }
    })
    const office = report.offices.find(o => o.officeId === 10)!
    expect(office.total).toBe(20)
    expect(office.unlisted).toBe(0)
    expect(report.total).toBe(30)
    expect(report.unlisted).toBe(0)
  })

  // «Не указана» — не офис, а незаполненное поле: на боевом портале в ней сделок больше всех,
  // и первой строкой она подменяла бы отчёт разговором о качестве данных.
  it('«моя компания не указана» стоит последней, даже когда она самая большая', () => {
    const report = buildManagerLoad({
      ...input,
      totals: {
        ...input.totals,
        [totalKey()]: 130,
        [officeKey(OFFICE_UNSET)]: 100,
        [pairKey(OFFICE_UNSET, 1)]: 100,
        [cellKey(OFFICE_UNSET, 1, 'NEW')]: 100
      }
    })
    expect(report.offices.map(o => o.officeId)).toEqual([10, 20, OFFICE_UNSET])
    expect(report.offices.at(-1)!.total).toBe(100)
  })

  it('без счётчиков — пустой отчёт, а не деление на ноль', () => {
    const report = buildManagerLoad({ ...input, totals: {} })
    expect(report).toEqual(emptyManagerLoad())
  })
})

describe('итоги колонок — счётчики портала, а не суммы клеток', () => {
  const base = {
    offices: OFFICES,
    managers: MANAGERS,
    stages: stagesForScope(STAGES, 'in-work'),
    totals: totals({
      [totalKey()]: 30,
      [officeKey(10)]: 25,
      [pairKey(10, 1)]: 12,
      [cellKey(10, 1, 'NEW')]: 5,
      [cellKey(10, 1, '1')]: 7,
      // Итоги колонок больше суммы клеток ровно на сделки без ответственного (25 − 12 = 13).
      [officeStageKey(10, 'NEW')]: 8,
      [officeStageKey(10, '1')]: 17
    })
  }

  // Ровно та причина, по которой колонка спрашивается отдельно: клик по её итогу открывает
  // список по «офис + стадия», и число обязано совпадать с длиной этого списка.
  it('итог колонки берётся из счётчика, даже если он больше суммы строк', () => {
    const office = buildManagerLoad(base).offices[0]!
    expect(office.byStage).toEqual({ NEW: 8, 1: 17 })
    expect(office.total).toBe(25)
  })

  it('разница раскладывается в строку «вне таблицы» по стадиям', () => {
    const office = buildManagerLoad(base).offices[0]!
    expect(office.unlisted).toBe(13)
    expect(office.unlistedByStage).toEqual({ NEW: 3, 1: 10 })
  })

  it('сошлось: колонки плюс прочие стадии равны итогу офиса', () => {
    const office = buildManagerLoad(base).offices[0]!
    const columns = Object.values(office.byStage).reduce((sum, value) => sum + value, 0)
    expect(columns + office.otherStages).toBe(office.total)
  })

  // Стадии считаются по кнопке: колонок нет вовсе, и «прочими» не может стать вся таблица.
  it('без колонок остатков по стадиям нет', () => {
    const report = buildManagerLoad({ ...base, stages: [] })
    expect(report.stages).toEqual([])
    expect(report.otherStages).toBe(0)
    expect(report.offices[0]!.rows[0]!.otherStages).toBe(0)
    expect(report.offices[0]!.total).toBe(25)
  })
})

describe('остатки уровня отчёта', () => {
  // Офис не перечислился (цепочка упёрлась в предел): его сделки есть в общем итоге, но ни в
  // одной строке. Молчать о них нельзя — это те же «сделки вне таблицы».
  it('сделки офиса, которого нет в списке, попадают в общий остаток', () => {
    const report = buildManagerLoad({
      offices: [{ id: 10, name: 'Минск' }],
      managers: MANAGERS,
      stages: stagesForScope(STAGES, 'in-work'),
      totals: totals({
        [totalKey()]: 50,
        [officeKey(10)]: 20,
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
      offices: [{ id: 10, name: 'Минск' }],
      managers: [{ id: 1, name: 'Яковлев Ян' }, { id: 2, name: 'Абрамов Абрам' }],
      stages: stagesForScope(STAGES, 'in-work'),
      totals: totals({
        [totalKey()]: 10,
        [officeKey(10)]: 10,
        [pairKey(10, 1)]: 5,
        [pairKey(10, 2)]: 5
      })
    })
    expect(report.offices[0]!.rows.map(row => row.managerName)).toEqual(['Абрамов Абрам', 'Яковлев Ян'])
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
