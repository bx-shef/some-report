import { describe, expect, it } from 'vitest'
import {
  PERIOD_PRESETS,
  fromIsoDate,
  matchPreset,
  periodLengthDays,
  resolvePreset,
  toIsoDate,
  validatePeriod
} from '~/utils/period'

/** 3 сентября 2026 — тот самый день, когда заказчик открыл отчёт и увидел пустой месяц. */
const TODAY = new Date(2026, 8, 3)

describe('toIsoDate', () => {
  it('печатает локальную дату', () => {
    expect(toIsoDate(new Date(2026, 8, 1))).toBe('2026-09-01')
  })

  // ⚠ Через `toISOString()` восточнее Гринвича полночь 1 сентября превратилась бы в 31 августа:
  // отчёт захватывал бы лишние сутки в начале периода и терял их в конце.
  it('не уезжает на сутки от часового пояса', () => {
    expect(toIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(toIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('fromIsoDate', () => {
  it('разбирает ISO-дату', () => {
    expect(toIsoDate(fromIsoDate('2026-09-15')!)).toBe('2026-09-15')
  })

  // `new Date(2026, 1, 31)` молча становится 3 марта — такую «дату» в фильтр пускать нельзя.
  it('несуществующую дату не выдумывает', () => {
    expect(fromIsoDate('2026-02-31')).toBeUndefined()
    expect(fromIsoDate('2026-13-01')).toBeUndefined()
  })

  it('мусор отвергает', () => {
    expect(fromIsoDate('01.09.2026')).toBeUndefined()
    expect(fromIsoDate('')).toBeUndefined()
  })
})

describe('готовые интервалы', () => {
  it('текущий месяц — от первого до последнего числа', () => {
    expect(resolvePreset('this-month', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  // ⚠ Ради этого пресет и заведён: отчёт, открытый 3-го числа, показывает три дня — почти пустой
  // экран, который читается как поломка. Полный прошлый месяц и есть тот ответ, за которым пришли.
  it('прошлый месяц — полный', () => {
    expect(resolvePreset('prev-month', TODAY)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('прошлый месяц в январе — это декабрь прошлого года', () => {
    expect(resolvePreset('prev-month', new Date(2026, 0, 10))).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('февраль високосного года считается верно', () => {
    expect(resolvePreset('this-month', new Date(2028, 1, 10))?.to).toBe('2028-02-29')
  })

  it('последние 7 дней включают сегодня', () => {
    expect(resolvePreset('last7', TODAY)).toEqual({ from: '2026-08-28', to: '2026-09-03' })
  })

  it('последние 30 дней включают сегодня', () => {
    expect(periodLengthDays(resolvePreset('last30', TODAY)!)).toBe(30)
  })

  it('сегодня и вчера — по одному дню', () => {
    expect(resolvePreset('today', TODAY)).toEqual({ from: '2026-09-03', to: '2026-09-03' })
    expect(resolvePreset('yesterday', TODAY)).toEqual({ from: '2026-09-02', to: '2026-09-02' })
  })

  it('квартал считается от начала своей тройки месяцев', () => {
    expect(resolvePreset('this-quarter', TODAY)).toEqual({ from: '2026-07-01', to: '2026-09-30' })
    expect(resolvePreset('this-quarter', new Date(2026, 0, 5))).toEqual({ from: '2026-01-01', to: '2026-03-31' })
  })

  it('год — целиком', () => {
    expect(resolvePreset('this-year', TODAY)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('произвольный интервал сам себя не вычисляет', () => {
    expect(resolvePreset('custom', TODAY)).toBeUndefined()
  })

  it('у каждого интервала есть подпись', () => {
    for (const preset of PERIOD_PRESETS) expect(preset.label.trim()).not.toBe('')
  })
})

describe('matchPreset', () => {
  // Иначе после ручного ввода «01.09 — 30.09» подсветится «Произвольный», и человек видит, что
  // система не понимает того, что он только что выбрал.
  it('узнаёт готовый интервал во введённых руками датах', () => {
    expect(matchPreset({ from: '2026-09-01', to: '2026-09-30' }, TODAY)).toBe('this-month')
    expect(matchPreset({ from: '2026-08-01', to: '2026-08-31' }, TODAY)).toBe('prev-month')
  })

  it('чужие границы называет произвольными', () => {
    expect(matchPreset({ from: '2026-08-15', to: '2026-09-02' }, TODAY)).toBe('custom')
  })
})

describe('periodLengthDays', () => {
  it('считает обе границы включительно', () => {
    expect(periodLengthDays({ from: '2026-09-01', to: '2026-09-01' })).toBe(1)
    expect(periodLengthDays({ from: '2026-09-01', to: '2026-09-30' })).toBe(30)
  })

  // Переход на летнее время в сутках длиной 23 часа не должен округляться вниз.
  it('не сбивается на переводе часов', () => {
    expect(periodLengthDays({ from: '2026-03-01', to: '2026-04-01' })).toBe(32)
  })
})

describe('validatePeriod', () => {
  it('годный период не трогает', () => {
    expect(validatePeriod({ from: '2026-09-01', to: '2026-09-30' })).toBeUndefined()
  })

  // ⚠ Перевёрнутый период REST принимает без ошибки и возвращает пустой список — отчёт показал бы
  // нули, неотличимые от «за период ничего не было», и человек искал бы ошибку в CRM.
  it('перевёрнутый период ловит и предлагает починку', () => {
    const problem = validatePeriod({ from: '2026-09-30', to: '2026-09-01' })
    expect(problem?.message).toContain('поменяны местами')
    expect(problem?.fixed).toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('слишком длинный период отклоняет', () => {
    expect(validatePeriod({ from: '2024-01-01', to: '2026-01-01' })?.message).toContain('покороче')
  })

  it('битые даты отклоняет до похода в портал', () => {
    expect(validatePeriod({ from: 'вчера', to: '2026-09-30' })?.message).toContain('неверно')
  })

  it('ровно граничная длина проходит', () => {
    expect(validatePeriod({ from: '2026-01-01', to: '2026-01-10' }, 10)).toBeUndefined()
    expect(validatePeriod({ from: '2026-01-01', to: '2026-01-11' }, 10)?.message).toContain('покороче')
  })
})
