import { describe, expect, it } from 'vitest'
import type { AdapterInput, B24CurrencyRow } from '~/utils/b24Adapter'
import {
  adaptPortalData,
  baseCurrency,
  currencyRates,
  leadOutcome,
  statusNames,
  toBaseAmount,
  toNumber
} from '~/utils/b24Adapter'

/**
 * Формы данных здесь — НЕ выдуманные: это то, что реально отдал тестовый портал
 * (`bel.bitrix24.by`, только чтение) при замере. В частности: идентификаторы приходят строками,
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
    ['пустая строка', '', 0],
    ['мусор', 'не число', 0],
    ['NaN', Number.NaN, 0]
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

  // Нулевой курс обнулил бы всю выручку в этой валюте молча.
  it('нулевой или битый курс не обнуляет суммы', () => {
    expect(currencyRates([{ CURRENCY: 'XXX', AMOUNT: '0', AMOUNT_CNT: '1' }]).XXX).toBe(1)
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
})

describe('leadOutcome', () => {
  // ⚠ Брак определяется СЕМАНТИКОЙ, а не кодом JUNK: заказчик заведёт свои стадии брака,
  // и захардкоженный код перестал бы их считать ровно тогда, когда блок наполнится данными.
  it('семантика «провал» — это брак, каким бы ни был код стадии', () => {
    expect(leadOutcome('F', false)).toBe('junk')
    expect(leadOutcome('F', true)).toBe('junk')
  })

  it('есть сделка — квалифицирован', () => {
    expect(leadOutcome('P', true)).toBe('converted')
  })

  it('в работе без сделки — в работе', () => {
    expect(leadOutcome('P', false)).toBe('in-work')
  })

  // Лид «сконвертирован» по стадии, но сделки нет: так бывает при конверсии только в контакт
  // или когда сделка вышла за границы периода. Квалифицированным его считать нельзя.
  it('стадия «успех» без сделки — закрыт без сделки', () => {
    expect(leadOutcome('S', false)).toBe('lost')
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

describe('adaptPortalData', () => {
  const input: AdapterInput = {
    currencies: CURRENCIES,
    sources: [{ STATUS_ID: 'CALL', NAME: 'Звонок' }, { STATUS_ID: 'EMAIL', NAME: 'Электронная почта' }],
    leadStatuses: [
      { STATUS_ID: 'NEW', NAME: 'Не обработан' },
      { STATUS_ID: 'CONVERTED', NAME: 'Качественный лид' },
      { STATUS_ID: 'JUNK', NAME: 'Некачественный лид' }
    ],
    dealStages: [
      { STATUS_ID: 'WON', NAME: 'Сделка успешна' },
      { STATUS_ID: 'LOSE', NAME: 'Сделка провалена' },
      { STATUS_ID: 'APOLOGY', NAME: 'Анализ причины провала' }
    ],
    leads: [
      { ID: '1', STATUS_ID: 'NEW', STATUS_SEMANTIC_ID: 'P', SOURCE_ID: 'CALL', ASSIGNED_BY_ID: '1', DATE_CREATE: '2026-08-01T10:00:00+03:00' },
      { ID: '2', STATUS_ID: 'CONVERTED', STATUS_SEMANTIC_ID: 'S', SOURCE_ID: 'EMAIL', ASSIGNED_BY_ID: '1', DATE_CREATE: '2026-08-02T10:00:00+03:00' },
      { ID: '3', STATUS_ID: 'JUNK', STATUS_SEMANTIC_ID: 'F', SOURCE_ID: 'EMAIL', ASSIGNED_BY_ID: '1', DATE_CREATE: '2026-08-03T10:00:00+03:00' },
      { ID: '4', STATUS_ID: 'CONVERTED', STATUS_SEMANTIC_ID: 'S', SOURCE_ID: 'CALL', ASSIGNED_BY_ID: '2', DATE_CREATE: '2026-08-04T10:00:00+03:00' }
    ],
    deals: [
      { ID: '10', LEAD_ID: '2', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '10300', CURRENCY_ID: 'BYN', ASSIGNED_BY_ID: '1' },
      { ID: '11', LEAD_ID: null, STAGE_ID: 'APOLOGY', STAGE_SEMANTIC_ID: 'F', OPPORTUNITY: '456000', CURRENCY_ID: 'RUB', ASSIGNED_BY_ID: '1' }
    ]
  }

  const result = adaptPortalData(input)

  it('приводит идентификаторы к числам', () => {
    expect(result.leads.map(l => l.id)).toEqual([1, 2, 3, 4])
    expect(result.deals.map(d => d.id)).toEqual([10, 11])
  })

  it('связывает сделки с лидами по LEAD_ID из СДЕЛКИ', () => {
    expect(result.leads.find(l => l.id === 2)?.dealIds).toEqual([10])
    expect(result.leads.find(l => l.id === 1)?.dealIds).toEqual([])
  })

  it('брак берёт стадию как причину', () => {
    const junk = result.leads.find(l => l.id === 3)
    expect(junk?.outcome).toBe('junk')
    expect(junk?.junkReasonId).toBe('JUNK')
  })

  // Вторая стадия провала портала. Захардкоженный `LOSE` потерял бы эту сделку.
  it('APOLOGY — тоже проигрыш, по семантике', () => {
    const lost = result.deals.find(d => d.id === 11)
    expect(lost?.outcome).toBe('lost')
    expect(lost?.lossReasonId).toBe('APOLOGY')
  })

  it('переводит сумму в базовую валюту портала', () => {
    expect(result.currencyId).toBe('BYN')
    expect(result.deals.find(d => d.id === 11)?.amount).toBeCloseTo(16_096.8, 6)
  })

  it('успешной сделке причину проигрыша не приписывает', () => {
    expect(result.deals.find(d => d.id === 10)?.lossReasonId).toBeUndefined()
  })

  /**
   * ⚠ Оговорки к данным отчёт обязан сообщать вслух. Лид №4 помечен «Качественный лид», но
   * сделки по нему нет; сделка №11 без лида-родителя — в разрез источников она не попадёт.
   * Молчаливое расхождение читается как ошибка отчёта.
   */
  it('считает оговорки к качеству данных', () => {
    expect(result.warnings).toEqual({
      unconvertedDeals: 0,
      convertedWithoutDeal: 1,
      dealsWithoutLead: 1
    })
  })

  it('считает сделки в валюте без курса', () => {
    const odd = adaptPortalData({
      ...input,
      deals: [{ ID: '12', LEAD_ID: '1', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '500', CURRENCY_ID: 'XYZ' }]
    })
    expect(odd.warnings.unconvertedDeals).toBe(1)
    expect(odd.deals[0]!.amount).toBe(500)
  })

  it('строит справочники для печати имён', () => {
    expect(result.dictionaries.sources.CALL).toBe('Звонок')
    expect(result.dictionaries.junkReasons.JUNK).toBe('Некачественный лид')
    expect(result.dictionaries.lossReasons.APOLOGY).toBe('Анализ причины провала')
  })

  it('пустой портал не роняет адаптер', () => {
    const empty = adaptPortalData({ leads: [], deals: [], currencies: [], sources: [], leadStatuses: [], dealStages: [] })
    expect(empty.leads).toEqual([])
    expect(empty.warnings).toEqual({ unconvertedDeals: 0, convertedWithoutDeal: 0, dealsWithoutLead: 0 })
  })
})
