import { describe, expect, it } from 'vitest'
import type { B24CurrencyRow } from '~/utils/b24Adapter'
import {
  baseCurrency,
  classifyCurrency,
  currencyRates,
  statusNames,
  toBaseAmount,
  toNumber
} from '~/utils/b24Adapter'

/**
 * Формы данных здесь — НЕ выдуманные: это то, что реально отдал тестовый портал
 * при замере (только чтение). В частности: идентификаторы приходят строками,
 * `LEAD_ID` бывает `null`, а курс рубля задан за сотню единиц.
 */
const CURRENCIES: B24CurrencyRow[] = [
  { CURRENCY: 'BYN', BASE: 'Y', AMOUNT: '1.0000', AMOUNT_CNT: '1' },
  { CURRENCY: 'RUB', BASE: 'N', AMOUNT: '3.5300', AMOUNT_CNT: '100' },
  { CURRENCY: 'USD', BASE: 'N', AMOUNT: '2.1400', AMOUNT_CNT: '1' }
]

describe('toNumber', () => {
  it.each([
    ['строка от REST', '37', 37],
    ['дробная строка', '10300.50', 10300.5],
    ['число', 42, 42],
    ['null', null, 0],
    ['undefined', undefined, 0],
    ['пустая строка', '', 0],
    ['мусор', 'не число', 0],
    ['NaN', Number.NaN, 0],
    // ⚠ Классическая ловушка JS: `Number(['5']) === 5`, `Number([]) === 0`. Защита держится на
    // проверке `typeof value === 'string'`; «упрощение» до `Number(value) || 0` протащило бы
    // массив из REST как число, и тест обязан это ловить.
    ['массив', ['5'], 0],
    ['пустой массив', [], 0],
    ['объект', {}, 0],
    ['boolean', true, 0],
    ['бесконечность', Number.POSITIVE_INFINITY, 0]
  ])('%s → %s', (_name, input, expected) => {
    expect(toNumber(input)).toBe(expected)
  })
})

describe('currencyRates', () => {
  /**
   * ⚠ Главная ловушка конвертации. У рубля на живом портале `AMOUNT=3.53` при `AMOUNT_CNT=100`:
   * курс задан ЗА СОТНЮ. Умножение просто на `AMOUNT` завысило бы такие сделки в сто раз, и в
   * отчёте это выглядело бы как обычное большое число.
   */
  it('делит курс на количество единиц', () => {
    expect(currencyRates(CURRENCIES).RUB).toBeCloseTo(0.0353, 10)
  })

  it('курс за одну единицу берёт как есть', () => {
    expect(currencyRates(CURRENCIES).USD).toBe(2.14)
  })

  it('базовая валюта имеет курс 1', () => {
    expect(currencyRates(CURRENCIES).BYN).toBe(1)
  })

  /**
   * ⚠ Самый дорогой дефект адаптера, найденный на ревью. Битая строка курса подменялась
   * единицей: сделка на 456 000 RUB превращалась в 456 000 BYN — завышение в 28 раз, и при этом
   * `unconvertedDeals` оставался нулём, то есть отчёт МОЛЧАЛ. Теперь такая строка просто не
   * попадает в курсы, и сделка уходит в ветку «неизвестная валюта» со счётчиком оговорок.
   */
  it.each([
    ['пустой AMOUNT', { CURRENCY: 'XXX', AMOUNT: '', AMOUNT_CNT: '100' }],
    ['нулевой AMOUNT', { CURRENCY: 'XXX', AMOUNT: '0', AMOUNT_CNT: '1' }],
    ['мусор в AMOUNT', { CURRENCY: 'XXX', AMOUNT: 'абв', AMOUNT_CNT: '1' }],
    ['нулевой AMOUNT_CNT', { CURRENCY: 'XXX', AMOUNT: '3.53', AMOUNT_CNT: '0' }],
    // Отрицательный делитель дал бы отрицательный курс и отрицательную выручку, неотличимую
    // в отчёте от честного возврата.
    ['отрицательный AMOUNT_CNT', { CURRENCY: 'XXX', AMOUNT: '3.53', AMOUNT_CNT: '-100' }],
    ['отрицательный AMOUNT', { CURRENCY: 'XXX', AMOUNT: '-3.53', AMOUNT_CNT: '1' }]
  ])('%s — курса нет вовсе, а не курс 1', (_name, row) => {
    expect(currencyRates([row]).XXX).toBeUndefined()
  })
})

describe('baseCurrency', () => {
  it('находит валюту с BASE = Y', () => {
    expect(baseCurrency(CURRENCIES)).toBe('BYN')
  })

  it('без явной базовой берёт первую, а не остаётся без валюты', () => {
    expect(baseCurrency([{ CURRENCY: 'USD', BASE: 'N' }])).toBe('USD')
  })

  it('пустой список даёт пустую строку', () => {
    expect(baseCurrency([])).toBe('')
  })
})

describe('toBaseAmount', () => {
  const rates = currencyRates(CURRENCIES)

  it('переводит рубли в базовую валюту', () => {
    // 456 000 RUB × 3,53 / 100 = 16 096,8 BYN — сделка с живого портала.
    expect(toBaseAmount(456_000, 'RUB', rates)).toEqual({ value: 16_096.8, converted: true })
  })

  it('базовую валюту оставляет как есть', () => {
    expect(toBaseAmount(10_300, 'BYN', rates)).toEqual({ value: 10_300, converted: true })
  })

  /**
   * ⚠ Неизвестная валюта не обнуляется и не конвертируется по выдуманному курсу: и то и другое
   * в отчёте выглядит как обычное число. Вместо этого сумма идёт как есть, а факт помечается.
   */
  it('неизвестную валюту оставляет как есть и помечает', () => {
    expect(toBaseAmount(100, 'XYZ', rates)).toEqual({ value: 100, converted: false })
  })

  // Портал без настроенных валют: `baseCurrency([])` даёт пустую строку.
  it('пустой код валюты — тоже «курса нет»', () => {
    expect(toBaseAmount(100, '', {})).toEqual({ value: 100, converted: false })
  })
})

describe('statusNames', () => {
  it('строит код → имя', () => {
    expect(statusNames([{ STATUS_ID: 'CALL', NAME: 'Звонок' }])).toEqual({ CALL: 'Звонок' })
  })

  it('элемент без имени остаётся под своим кодом', () => {
    expect(statusNames([{ STATUS_ID: 'UC_X1', NAME: null }])).toEqual({ UC_X1: 'UC_X1' })
  })
})

describe('classifyCurrency', () => {
  const RATES = { BYN: 1, RUB: 0.037 }

  /**
   * ⛔ Инвариант, на котором держатся ОБА счётчика: одна сделка не может попасть в оба сразу.
   * Первый растёт по `!converted`, второй по `foreign` — значит запретное сочетание ровно одно:
   * `foreign` без `converted`. ⚠ Это НЕ «флаги исключают друг друга»: у известной чужой валюты
   * истинны оба, она и приведена, и чужая. Ровно так и было написано в JSDoc — неверно, и
   * поймал это вот этот тест, а не чтение.
   */
  it('в ДВА счётчика одна сделка не попадает ни на одной комбинации', () => {
    const cases: [string, Record<string, number>][] = [
      ['BYN', RATES], ['RUB', RATES], ['XYZ', RATES],
      ['BYN', {}], ['RUB', {}], ['', RATES]
    ]
    for (const [code, rates] of cases) {
      const got = classifyCurrency(100, code, 'BYN', rates)
      expect(!got.converted && got.foreign, `${code || '(пусто)'} при ${JSON.stringify(rates)}`).toBe(false)
    }
  })

  it('базовая валюта: приведена, но не чужая — ни в один счётчик не идёт', () => {
    expect(classifyCurrency(100, 'BYN', 'BYN', RATES)).toEqual({ value: 100, converted: true, foreign: false })
  })

  // Базовая валюта считается приведённой, даже когда её строки в справочнике нет вовсе.
  it('базовая валюта без своей строки курса — всё равно не «без курса»', () => {
    expect(classifyCurrency(100, 'BYN', 'BYN', {})).toEqual({ value: 100, converted: true, foreign: false })
  })

  it('известная чужая валюта: приведена курсом и помечена чужой', () => {
    const got = classifyCurrency(100, 'RUB', 'BYN', RATES)
    expect(got.foreign).toBe(true)
    expect(got.converted).toBe(true)
    expect(got.value).toBeCloseTo(3.7, 6)
  })

  it('валюта без курса: сумма КАК ЕСТЬ и не помечена чужой — её нечем приводить', () => {
    expect(classifyCurrency(100, 'XYZ', 'BYN', RATES)).toEqual({ value: 100, converted: false, foreign: false })
  })
})
