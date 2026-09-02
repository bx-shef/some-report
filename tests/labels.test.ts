import { describe, expect, it } from 'vitest'
import type { ReportDictionaries } from '~/types/report'
import { junkReasonLabel, labelFor, lossReasonLabel, sourceLabel } from '~/utils/labels'
import { UNSPECIFIED_REASON, UNSPECIFIED_SOURCE } from '~/utils/metrics'

const dictionaries: ReportDictionaries = {
  sources: { CALL: 'Входящий звонок' },
  junkReasons: { JUNK_SPAM: 'Спам' },
  lossReasons: { LOSS_PRICE: 'Цена' }
}

describe('labelFor', () => {
  it('находит имя по коду', () => {
    expect(labelFor({ A: 'Альфа' }, 'A', 'нет')).toBe('Альфа')
  })

  // Неизвестный код печатаем как есть: по нему запись хотя бы можно найти в CRM.
  it('неизвестный код печатает как есть, а не прочерком', () => {
    expect(labelFor({}, 'UC_X4F2K1', 'нет')).toBe('UC_X4F2K1')
  })

  it('служебный код «не заполнено» заменяет человеческим текстом', () => {
    expect(labelFor({}, UNSPECIFIED_SOURCE, 'Другие источники')).toBe('Другие источники')
    expect(labelFor({}, UNSPECIFIED_REASON, 'Причина не указана')).toBe('Причина не указана')
  })
})

describe('обёртки по справочникам', () => {
  it('источник', () => {
    expect(sourceLabel(dictionaries, 'CALL')).toBe('Входящий звонок')
    expect(sourceLabel(dictionaries, UNSPECIFIED_SOURCE)).toBe('Другие источники')
  })

  it('причина брака', () => {
    expect(junkReasonLabel(dictionaries, 'JUNK_SPAM')).toBe('Спам')
    expect(junkReasonLabel(dictionaries, UNSPECIFIED_REASON)).toBe('Причина не указана')
  })

  it('причина проигрыша', () => {
    expect(lossReasonLabel(dictionaries, 'LOSS_PRICE')).toBe('Цена')
    expect(lossReasonLabel(dictionaries, UNSPECIFIED_REASON)).toBe('Причина не указана')
  })
})
