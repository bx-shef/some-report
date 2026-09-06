import { describe, expect, it } from 'vitest'
import { formatCount, formatDate, formatDuration, formatMoney, formatPercent, formatSeconds } from '~/utils/format'
import { nbsp } from './helpers/text'

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

/**
 * Отрицательные значения — не выдумка: `OPPORTUNITY` в CRM бывает отрицательной (возврат,
 * корректировка), а `formatDuration` защищается `Math.max(0, …)`, и эта защита нигде не
 * проверялась. Фиксируем ожидаемый вид, чтобы «минус» не появился в отчёте случайно.
 */
describe('отрицательные значения', () => {
  it('количество печатается со знаком', () => {
    expect(nbsp(formatCount(-10))).toBe('-10')
  })

  it('сумма печатается со знаком и кодом валюты', () => {
    expect(nbsp(formatMoney(-500, 'BYN'))).toBe('-500 BYN')
  })

  it('отрицательная доля печатается со знаком, а не гасится', () => {
    expect(nbsp(formatPercent(-0.05))).toBe('-5 %')
  })

  // Длительность — единственная величина, которая отрицательной быть не может по смыслу.
  it('отрицательная длительность схлопывается в ноль', () => {
    expect(formatDuration(-5)).toBe('0 мин')
  })
})

describe('formatDate', () => {
  it('печатает ISO-дату по-русски', () => {
    expect(formatDate('2026-09-01')).toBe('01.09.2026')
  })

  // ⚠ Через `new Date('2026-09-01')` это была бы полночь UTC, и западнее Гринвича подпись
  // печатала бы 31 августа — молчаливая ошибка на сутки в каждой границе периода.
  it('не сдвигает дату часовым поясом', () => {
    expect(formatDate('2026-01-01')).toBe('01.01.2026')
    expect(formatDate('2026-12-31')).toBe('31.12.2026')
  })

  it('непонятную строку отдаёт как есть, а не ломает подпись', () => {
    expect(formatDate('когда-нибудь')).toBe('когда-нибудь')
  })
})

describe('formatSeconds', () => {
  it.each([
    [0, '0 с'],
    [45, '45 с'],
    [59, '59 с'],
    [60, '1 мин 0 с'],
    [750, '12 мин 30 с'],
    [3599, '59 мин 59 с'],
    [3600, '1 ч 0 мин'],
    [12345, '3 ч 25 мин']
  ])('%i секунд → %s', (input, expected) => {
    expect(formatSeconds(input)).toBe(expected)
  })

  /**
   * ⚠ Прочерк, а не «0 с». Ноль означал бы «разговоры были и длились нисколько» — то же правило,
   * что у `averageCallSeconds`, которая для пустого счёта возвращает `undefined`.
   */
  it('нет разговоров — прочерк, а не ноль', () => {
    expect(formatSeconds(undefined)).toBe('—')
    expect(formatSeconds(Number.NaN)).toBe('—')
  })

  /**
   * ⚠ Средний разговор в полторы минуты — то число, ради которого столбец и смотрят. Минутный
   * формат напечатал бы «2 мин» и потерял бы весь смысл.
   */
  it('секунды не теряются на коротких разговорах', () => {
    expect(formatSeconds(95)).toBe('1 мин 35 с')
    expect(formatDuration(95 / 60)).toBe('2 мин')
  })
})
