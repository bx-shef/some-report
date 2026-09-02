import { describe, expect, it } from 'vitest'
import { formatCount, formatDuration, formatMoney, formatPercent } from '~/utils/format'

/**
 * `ru-RU` разделяет разряды НЕРАЗРЫВНЫМ пробелом (U+00A0), а перед знаком процента может
 * поставить узкий неразрывный (U+202F). Здесь они записаны escape-последовательностями
 * намеренно: набранные буквально, они неотличимы от обычного пробела при чтении диффа — и
 * тест краснеет «без причины».
 */
const nbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, ' ')

describe('formatCount', () => {
  it('разделяет разряды', () => {
    expect(nbsp(formatCount(1250))).toBe('1 250')
  })

  it('нечисло печатает прочерком, а не «NaN»', () => {
    expect(formatCount(Number.NaN)).toBe('—')
  })
})

describe('formatPercent', () => {
  it('целую долю печатает без дробной части', () => {
    expect(nbsp(formatPercent(0.8))).toBe('80 %')
  })

  it('дробную — с одним знаком, как на макете', () => {
    expect(nbsp(formatPercent(0.496))).toBe('49,6 %')
  })

  it('округляет к одному знаку', () => {
    expect(nbsp(formatPercent(1 / 3))).toBe('33,3 %')
  })

  it('ноль остаётся нулём', () => {
    expect(nbsp(formatPercent(0))).toBe('0 %')
  })
})

describe('formatMoney', () => {
  it('печатает код валюты суффиксом', () => {
    expect(nbsp(formatMoney(485_000, 'BYN'))).toBe('485 000 BYN')
  })

  // Код валюты приходит из справочника портала и может быть нестандартным: `Intl` со
  // `style: 'currency'` на таком коде бросает исключение прямо во время отрисовки.
  it('не падает на незнакомом коде валюты', () => {
    expect(nbsp(formatMoney(100, 'XYZ'))).toBe('100 XYZ')
  })

  it('без кода валюты печатает просто число', () => {
    expect(nbsp(formatMoney(100, ''))).toBe('100')
  })
})

describe('formatDuration', () => {
  it.each([
    [42, '42 мин'],
    [95, '1 ч 35 мин'],
    [2880, '2 дн 0 ч'],
    [0, '0 мин']
  ])('%s мин → %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected)
  })

  it('отсутствие значения печатает прочерком', () => {
    expect(formatDuration(undefined)).toBe('—')
  })
})
