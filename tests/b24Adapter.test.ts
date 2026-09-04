import { describe, expect, it } from 'vitest'
import { buildReport } from '~/utils/metrics'
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

describe('leadOutcome', () => {
  // ⚠ Брак определяется СЕМАНТИКОЙ, а не кодом JUNK: заказчик заведёт свои стадии брака,
  // и захардкоженный код перестал бы их считать ровно тогда, когда блок наполнится данными.
  it('семантика «провал» — это брак, каким бы ни был код стадии', () => {
    expect(leadOutcome('F', false)).toBe('junk')
    expect(leadOutcome('F', true)).toBe('junk')
  })

  it.each([
    ['в работе', 'P' as const],
    ['успех', 'S' as const]
  ])('%s со сделкой — квалифицирован', (_name, semantic) => {
    expect(leadOutcome(semantic, true)).toBe('converted')
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
      { STATUS_ID: 'WON', NAME: 'Сделка успешна', SEMANTICS: 'S' },
      { STATUS_ID: 'LOSE', NAME: 'Сделка провалена', SEMANTICS: 'F' },
      { STATUS_ID: 'APOLOGY', NAME: 'Анализ причины провала', SEMANTICS: 'F' }
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
    // Причина — каноничный ключ, а не код стадии; проверяем, что он ведёт к имени стадии APOLOGY.
    expect(result.dictionaries.lossReasons[lost!.lossReasonId!]).toBe('Анализ причины провала')
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
      mergedLossReasons: 0,
      unconvertedDeals: 0,
      wonStageWithoutDeal: 1,
      dealsWithoutLead: 1,
      dealsWithMissingLead: 0,
      duplicateIds: 0,
      firstResponseNotFetched: true,
      wonWithoutAmount: 0
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
    // Причины проигрыша лежат под каноничным ключом, а не под кодом стадии: им помечена сделка,
    // и по нему же печатается имя. Сверяем через саму сделку — так проверяется вся цепочка.
    const lost = result.deals.find(d => d.outcome === 'lost')!
    expect(lost.lossReasonId).toBeDefined()
    expect(result.dictionaries.lossReasons[lost.lossReasonId!]).toBe('Анализ причины провала')
  })

  /**
   * ⚠ Одна причина в двух направлениях — два кода стадии. Без сведения ядро печатало бы её двумя
   * строками; с боевого портала таких «дорого» приезжает шесть.
   */
  it('одноимённые стадии провала из разных направлений дают один lossReasonId', () => {
    const merged = adaptPortalData({
      ...input,
      dealStages: [
        // «Новая» продублирована в обоих направлениях — в счётчик свёрнутых попасть НЕ должна.
        { STATUS_ID: 'NEW', NAME: 'Новая', ENTITY_ID: 'DEAL_STAGE', SEMANTICS: null },
        { STATUS_ID: 'C1:NEW', NAME: 'Новая', ENTITY_ID: 'DEAL_STAGE_1', SEMANTICS: null },
        { STATUS_ID: 'LOSE', NAME: 'Отказ - Дорого', ENTITY_ID: 'DEAL_STAGE', SEMANTICS: 'F' },
        { STATUS_ID: 'C1:LOSE', NAME: 'Отказ - дорого', ENTITY_ID: 'DEAL_STAGE_1', SEMANTICS: 'F' }
      ],
      deals: [
        { ID: '21', LEAD_ID: '1', STAGE_ID: 'LOSE', STAGE_SEMANTIC_ID: 'F', OPPORTUNITY: '10', CURRENCY_ID: 'BYN' },
        { ID: '22', LEAD_ID: '1', STAGE_ID: 'C1:LOSE', STAGE_SEMANTIC_ID: 'F', OPPORTUNITY: '20', CURRENCY_ID: 'BYN' }
      ]
    })
    const [a, b] = merged.deals
    expect(a!.lossReasonId).toBe(b!.lossReasonId)
    expect(merged.dictionaries.lossReasons[a!.lossReasonId!]).toBe('Отказ - Дорого')
    expect(merged.warnings.mergedLossReasons).toBe(1)
  })

  it('пустой портал не роняет адаптер', () => {
    const empty = adaptPortalData({ leads: [], deals: [], currencies: [], sources: [], leadStatuses: [], dealStages: [] })
    expect(empty.leads).toEqual([])
    expect(empty.warnings).toMatchObject({ unconvertedDeals: 0, wonStageWithoutDeal: 0, dealsWithoutLead: 0, duplicateIds: 0 })
  })

  /**
   * ⚠ Сделка ссылается на лид, которого в выборке нет: он создан до начала периода либо удалён.
   * Раньше такая сделка не считалась нигде — `LEAD_ID` непустой, значит «с лидом», — и отчёт
   * уверял, что осиротевших сделок ноль, пока выручка молча выпадала из разреза источников.
   */
  it('сделка с LEAD_ID на лид вне выборки считается отдельно', () => {
    const result = adaptPortalData({
      ...input,
      deals: [{ ID: '20', LEAD_ID: '9999', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '1000', CURRENCY_ID: 'BYN' }]
    })
    expect(result.warnings.dealsWithMissingLead).toBe(1)
    expect(result.warnings.dealsWithoutLead).toBe(0)
    expect(result.leads.every(l => l.dealIds.length === 0)).toBe(true)
  })

  /**
   * ⚠ Повтор по `ID` — признак сбоя пагинации: постраничный опрос вернул страницу дважды. Без
   * дедупликации лид считался бы дважды, а из двух сделок с одним `ID` ядро оставляло бы в своей
   * карте только последнюю — и «успешные сделки» в сводке разошлись бы с выручкой по источникам
   * без единой подсказки, почему.
   */
  it('повтор по ID выбрасывается и попадает в счётчик', () => {
    const result = adaptPortalData({
      ...input,
      leads: [...input.leads, { ID: '1', STATUS_ID: 'NEW', STATUS_SEMANTIC_ID: 'P', SOURCE_ID: 'CALL', DATE_CREATE: '2026-08-09T10:00:00+03:00' }],
      deals: [...input.deals, { ID: '10', LEAD_ID: '2', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '99999', CURRENCY_ID: 'BYN' }]
    })
    expect(result.leads).toHaveLength(4)
    expect(result.deals).toHaveLength(2)
    expect(result.warnings.duplicateIds).toBe(2)
  })

  // Оставляем ПЕРВОЕ вхождение: при сбое пагинации повтор приходит позже оригинала.
  it('из повторов остаётся первое вхождение', () => {
    const result = adaptPortalData({
      ...input,
      deals: [
        { ID: '30', LEAD_ID: '2', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '100', CURRENCY_ID: 'BYN' },
        { ID: '30', LEAD_ID: '2', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '777', CURRENCY_ID: 'BYN' }
      ]
    })
    expect(result.deals).toHaveLength(1)
    expect(result.deals[0]!.amount).toBe(100)
  })

  it('несколько сделок у одного лида попадают все', () => {
    const result = adaptPortalData({
      ...input,
      deals: [
        { ID: '21', LEAD_ID: '1', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '100', CURRENCY_ID: 'BYN' },
        { ID: '22', LEAD_ID: '1', STAGE_ID: 'LOSE', STAGE_SEMANTIC_ID: 'F', OPPORTUNITY: '200', CURRENCY_ID: 'BYN' }
      ]
    })
    expect(result.leads.find(l => l.id === 1)?.dealIds).toEqual([21, 22])
  })

  /**
   * ⚠ Незаполненная семантика — живой случай: стадию сняли с воронки и забыли привязать семантику.
   * Единственная защита от неё — приведение к `P` по умолчанию; без теста «упрощение» до
   * `text as B24Semantic` прошло бы незамеченным.
   */
  it('лид и сделка без семантики считаются «в работе», а не браком', () => {
    const result = adaptPortalData({
      ...input,
      leads: [{ ID: '50', STATUS_ID: 'UC_CUSTOM', STATUS_SEMANTIC_ID: null, SOURCE_ID: 'CALL', DATE_CREATE: '2026-08-01T10:00:00+03:00' }],
      deals: [{ ID: '51', LEAD_ID: '50', STAGE_ID: 'UC_STAGE', OPPORTUNITY: '10', CURRENCY_ID: 'BYN' }]
    })
    expect(result.leads[0]!.outcome).toBe('converted')
    expect(result.leads[0]!.junkReasonId).toBeUndefined()
    expect(result.deals[0]!.outcome).toBe('in-work')
    expect(result.deals[0]!.lossReasonId).toBeUndefined()
  })

  // Незаполненные поля — норма живого портала: снятый сотрудник, не выбранный источник.
  it('пустые источник и ответственный не роняют адаптер', () => {
    const result = adaptPortalData({
      ...input,
      leads: [{ ID: '60', STATUS_ID: 'NEW', STATUS_SEMANTIC_ID: 'P', SOURCE_ID: null, ASSIGNED_BY_ID: null, DATE_CREATE: '2026-08-01T10:00:00+03:00' }],
      deals: []
    })
    expect(result.leads[0]).toMatchObject({ sourceId: '', assignedById: 0 })
  })

  /**
   * ⚠ Блок «Обработка лидов» без этих данных показал бы «обработано 0 %, просрочено 100 %» — как
   * факт о работе отдела, хотя это факт о том, что данных не запрашивали. Признак обязателен.
   */
  describe('первое действие по лиду', () => {
    it('без входных данных помечает, что их не выбирали', () => {
      expect(result.warnings.firstResponseNotFetched).toBe(true)
      expect(result.leads.every(l => l.firstResponseAt === undefined)).toBe(true)
    })

    it('с входными данными проставляет дату и снимает пометку', () => {
      const withActivity = adaptPortalData({ ...input, firstResponse: { 1: '2026-08-01T10:30:00+03:00' } })
      expect(withActivity.warnings.firstResponseNotFetched).toBe(false)
      expect(withActivity.leads.find(l => l.id === 1)?.firstResponseAt).toBe('2026-08-01T10:30:00+03:00')
      expect(withActivity.leads.find(l => l.id === 2)?.firstResponseAt).toBeUndefined()
    })
  })
})

/**
 * Стык двух слоёв: выход адаптера обязан считаться ядром без сюрпризов. Юнит-тесты проверяют
 * каждый слой отдельно, и ровно между ними уже пряталась дыра — адаптер не заполнял
 * `firstResponseAt`, а поймать это можно было только прогнав одно через другое.
 */
describe('адаптер + ядро отчёта', () => {
  const adapted = adaptPortalData({
    currencies: CURRENCIES,
    sources: [{ STATUS_ID: 'CALL', NAME: 'Звонок' }],
    leadStatuses: [{ STATUS_ID: 'JUNK', NAME: 'Некачественный лид' }],
    dealStages: [{ STATUS_ID: 'LOSE', NAME: 'Сделка провалена' }],
    leads: [
      { ID: '1', STATUS_ID: 'NEW', STATUS_SEMANTIC_ID: 'P', SOURCE_ID: 'CALL', DATE_CREATE: '2026-08-01T10:00:00+03:00' },
      { ID: '2', STATUS_ID: 'JUNK', STATUS_SEMANTIC_ID: 'F', SOURCE_ID: 'CALL', DATE_CREATE: '2026-08-02T10:00:00+03:00' },
      { ID: '3', STATUS_ID: 'NEW', STATUS_SEMANTIC_ID: 'P', SOURCE_ID: 'CALL', DATE_CREATE: '2026-08-03T10:00:00+03:00' }
    ],
    deals: [
      { ID: '10', LEAD_ID: '3', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '456000', CURRENCY_ID: 'RUB' },
      { ID: '11', LEAD_ID: null, STAGE_ID: 'LOSE', STAGE_SEMANTIC_ID: 'F', OPPORTUNITY: '10300', CURRENCY_ID: 'BYN' }
    ],
    firstResponse: { 1: '2026-08-01T10:20:00+03:00' }
  })

  const report = buildReport(adapted.leads, adapted.deals, {
    conversionBase: 'quality-leads',
    firstResponseSlaMinutes: 60,
    now: '2026-08-31T23:59:59Z'
  })

  it('ни одно число отчёта не превращается в NaN', () => {
    const numbers = [
      report.summary.junkShare, report.summary.qualifiedShare, report.summary.wonShare,
      report.summary.revenue, report.lostDeals.lostRevenue, report.lostDeals.shareOfQualified,
      report.preDealLoss.share, report.processing!.processedShare
    ]
    expect(numbers.every(Number.isFinite)).toBe(true)
  })

  it('считает по нормализованным данным то же, что мы ожидаем от портала', () => {
    expect(report.summary).toMatchObject({ totalLeads: 3, junk: 1, qualified: 1, wonDeals: 1 })
    // 456 000 RUB × 3,53 / 100 — конвертация доехала через оба слоя.
    expect(report.summary.revenue).toBeCloseTo(16_096.8, 6)
  })

  it('переданное первое действие доезжает до блока обработки', () => {
    expect(report.processing!.processed).toBe(1)
    expect(report.processing!.avgFirstResponseMinutes).toBe(20)
  })
})
