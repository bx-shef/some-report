import { describe, expect, it } from 'vitest'
import { adaptCategories, adaptStages, stageNames } from '~/utils/managerAdapter'

/**
 * Адаптер справочников отчёта «Сделки по менеджерам». Ошибка здесь не роняет отчёт — она тихо
 * подписывает колонку не тем именем или теряет стадию из охвата.
 */

describe('adaptStages', () => {
  it('семантика берётся из справочника, пустая — «в работе»', () => {
    const stages = adaptStages([
      { STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: null },
      { STATUS_ID: 'WON', NAME: 'Успех', SEMANTICS: 'S' },
      { STATUS_ID: 'C4:LOSE', NAME: 'Отказ', SEMANTICS: 'F' }
    ])
    expect(stages.map(stage => stage.semantic)).toEqual(['P', 'S', 'F'])
  })

  // Имя пустое — печатаем код: по нему стадию хотя бы можно найти в CRM, «—» ничего не даёт.
  it('без имени печатается код стадии', () => {
    expect(adaptStages([{ STATUS_ID: 'UC_X4F2K1', NAME: '   ' }])[0]!.name).toBe('UC_X4F2K1')
  })

  it('строки без кода стадии отбрасываются', () => {
    expect(adaptStages([{ STATUS_ID: '' }, { STATUS_ID: 'NEW', NAME: 'Новая' }])).toHaveLength(1)
  })
})

describe('stageNames', () => {
  it('код → имя для подписи стадии в списке по клику', () => {
    expect(stageNames([{ id: '1', name: 'Выставлен счёт', semantic: 'P' }])).toEqual({ 1: 'Выставлен счёт' })
  })
})

describe('adaptCategories', () => {
  // Направление 0 («Общее») — полноправное значение фильтра, а не «фильтра нет».
  it('нулевое направление остаётся в списке', () => {
    expect(adaptCategories([{ id: 0, name: 'Общее направление' }, { id: 3, name: 'Новые продажи' }]))
      .toEqual([{ id: 0, name: 'Общее направление' }, { id: 3, name: 'Новые продажи' }])
  })

  it('направление без имени подписывается номером, мусорное — отбрасывается', () => {
    expect(adaptCategories([{ id: 4, name: '  ' }, { id: 'нет', name: 'Чужое' }]))
      .toEqual([{ id: 4, name: 'Направление #4' }])
  })
})
