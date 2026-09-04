import { describe, expect, it } from 'vitest'
import { adaptDeals, adaptDealsContext, adaptLeadCounts, adaptUnlinkedWonDeals, dealCountKey, leadCountKey, lossStages, statusIdsBySemantic } from '~/utils/b24Adapter'
import { UNSPECIFIED_SOURCE, UNSPECIFIED_REASON } from '~/utils/metrics'
import { dealContextBatch, dealStageBatch, dealsFromLeadsParams, leadCountBatch, unlinkedWonDealsParams } from '~/utils/b24Query'
import { mergeReasons } from '~/utils/reasonMerge'

/**
 * Режим счётчиков: что спрашиваем у портала и как читаем ответ.
 *
 * ⚠ Ошибка здесь не даёт исключения — она даёт ноль в клетке отчёта, и выглядит это как «в этом
 * источнике лидов не было». Поэтому и ключи команд, и их разбор — под тестом, причём через ОДИН
 * словарь `leadCountKey`: разъехаться им негде.
 */
const PERIOD = { from: '2026-08-01', to: '2026-08-31' }

describe('statusIdsBySemantic', () => {
  it('отбирает стадии по семантике и пропускает стадии без неё', () => {
    const rows = [
      { STATUS_ID: 'NEW', SEMANTICS: null },
      { STATUS_ID: 'JUNK', SEMANTICS: 'F' },
      { STATUS_ID: '7', SEMANTICS: 'f' },
      { STATUS_ID: 'CONVERTED', SEMANTICS: 'S' }
    ]
    expect(statusIdsBySemantic(rows, 'F')).toEqual(['JUNK', '7'])
    expect(statusIdsBySemantic(rows, 'S')).toEqual(['CONVERTED'])
  })

  // Стадии в работе семантики не имеют вовсе — «P» им приписывает только адаптер строк.
  it('в работе — это отсутствие семантики, а не код P', () => {
    expect(statusIdsBySemantic([{ STATUS_ID: 'NEW', SEMANTICS: null }], 'P')).toEqual([])
  })
})

describe('leadCountBatch', () => {
  const batch = leadCountBatch(PERIOD, { junkStatusIds: ['JUNK', '7'], sourceIds: ['CALL', 'WEB'] })

  it('спрашивает итог, три семантики, каждую причину брака и три числа на источник', () => {
    // 4 + 2 причины + 2 источника × 3
    expect(Object.keys(batch)).toHaveLength(4 + 2 + 6)
    expect(batch[leadCountKey.total]?.params.filter).toEqual({ '>=DATE_CREATE': '2026-08-01', '<DATE_CREATE': '2026-09-01' })
    expect(batch[leadCountKey.junkReason('7')]?.params.filter).toMatchObject({ STATUS_ID: '7' })
    expect(batch[leadCountKey.sourceJunk('WEB')]?.params.filter).toMatchObject({ SOURCE_ID: 'WEB', STATUS_SEMANTIC_ID: 'F' })
  })

  // Счётчику нужен только `total`: тащить поля записей значило бы платить за строки, от которых
  // мы ушли.
  it('каждая команда просит только ID и первую страницу', () => {
    for (const command of Object.values(batch)) {
      expect(command.params.select).toEqual(['ID'])
      expect(command.params.start).toBe(0)
    }
  })
})

describe('adaptLeadCounts', () => {
  const totals = {
    [leadCountKey.total]: 100,
    [leadCountKey.junk]: 30,
    [leadCountKey.converted]: 20,
    [leadCountKey.inWork]: 40,
    [leadCountKey.junkReason('JUNK')]: 25,
    [leadCountKey.junkReason('7')]: 5,
    [leadCountKey.source('CALL')]: 60,
    [leadCountKey.sourceJunk('CALL')]: 10,
    [leadCountKey.sourceConverted('CALL')]: 15
  }
  const agg = adaptLeadCounts({ totals, sourceIds: ['CALL', 'WEB'], junkStatusIds: ['JUNK', '7'] })

  it('переносит итоги как есть', () => {
    expect(agg).toMatchObject({ total: 100, junk: 30, qualified: 20, inWork: 40, closedWithoutDeal: 10 })
    expect(agg.junkByReason).toEqual({ JUNK: 25, 7: 5 })
  })

  // ⚠ «Источник не указан» портал не спрашивается — он остаток: иначе лиды без источника исчезли
  // бы из таблицы, а её итог перестал бы сходиться со сводкой.
  it('лиды без источника считает остатком', () => {
    expect(agg.bySource.CALL).toEqual({ leads: 60, junk: 10, qualified: 15 })
    expect(agg.bySource[UNSPECIFIED_SOURCE]).toEqual({ leads: 40, junk: 20, qualified: 5 })
  })

  // Брак на стадии, которой нет в справочнике, в итоге по семантике ЕСТЬ. Без остатка таблица причин
  // молча недосчитывала бы этих лидов — со остатком они в «причина не указана», как и по строкам.
  it('брак на неизвестной стадии кладёт в «причина не указана»', () => {
    const totals = { [leadCountKey.total]: 10, [leadCountKey.junk]: 6, [leadCountKey.junkReason('JUNK')]: 4 }
    const agg = adaptLeadCounts({ totals, sourceIds: [], junkStatusIds: ['JUNK'] })
    expect(agg.junkByReason).toEqual({ JUNK: 4, [UNSPECIFIED_REASON]: 2 })
  })

  it('источник без лидов в таблицу не попадает', () => {
    expect(agg.bySource.WEB).toBeUndefined()
  })

  it('отсутствующий ключ читается как ноль, а не как NaN', () => {
    const empty = adaptLeadCounts({ totals: {}, sourceIds: ['CALL'], junkStatusIds: ['JUNK'] })
    expect(empty).toMatchObject({ total: 0, junk: 0, qualified: 0, inWork: 0, closedWithoutDeal: 0 })
    expect(empty.bySource).toEqual({})
  })

  // Счётчики не знают лидов поимённо: карты источников и обработки быть не должно, иначе ядро
  // решит, что строки есть, и начнёт по ним искать.
  it('не притворяется, что знает лиды построчно', () => {
    expect(agg.leadSourceById).toBeUndefined()
    expect(agg.processing).toBeUndefined()
  })
})

describe('сделки', () => {
  // ⚠ Только сделки ИЗ ЛИДОВ: на боевом портале это каждая десятая, и ровно они нужны построчно.
  it('строками просим только сделки с лидом', () => {
    expect(dealsFromLeadsParams(PERIOD).filter).toMatchObject({ '!LEAD_ID': null, '>=DATE_CREATE': '2026-08-01' })
  })

  it('контекст — три счётчика по семантике', () => {
    const batch = dealContextBatch(PERIOD)
    expect(Object.keys(batch).sort()).toEqual([dealCountKey.inWork, dealCountKey.lost, dealCountKey.won].sort())
    expect(batch[dealCountKey.won]?.params.filter).toMatchObject({ STAGE_SEMANTIC_ID: 'S' })
    expect(adaptDealsContext({ [dealCountKey.won]: 6076, [dealCountKey.lost]: 2064 }))
      .toEqual({ won: 6076, lost: 2064, inWork: 0 })
  })

  // `DEAL_STAGE` — только направление по умолчанию; у заказчика их четыре.
  it('стадии сделок просим по всем направлениям', () => {
    const batch = dealStageBatch([0, 1, 3, 4])
    expect(Object.keys(batch).sort()).toEqual(['c1', 'c3', 'c4', 'default'])
    expect(batch.c3?.params.filter).toEqual({ ENTITY_ID: 'DEAL_STAGE_3' })
  })
})

describe('adaptDeals', () => {
  const BYN = [{ CURRENCY: 'BYN', BASE: 'Y', AMOUNT: '1', AMOUNT_CNT: '1' }]
  const row = (patch: Record<string, unknown>) => ({
    ID: '1', LEAD_ID: '10', STAGE_ID: 'WON', STAGE_SEMANTIC_ID: 'S', OPPORTUNITY: '100', CURRENCY_ID: 'BYN', SOURCE_ID: 'CALL', ...patch
  })

  it('переводит строку в сделку с лидом, исходом и суммой', () => {
    const { deals } = adaptDeals([row({})], BYN)
    expect(deals[0]).toMatchObject({ id: 1, leadId: 10, outcome: 'won', amount: 100, sourceId: 'CALL' })
  })

  it('проигрыш несёт код стадии как причину', () => {
    const { deals } = adaptDeals([row({ STAGE_ID: 'C3:LOSE', STAGE_SEMANTIC_ID: 'F' })], BYN)
    expect(deals[0]).toMatchObject({ outcome: 'lost', lossReasonId: 'C3:LOSE' })
  })

  it('повтор по ID отбрасывает и считает', () => {
    const { deals, duplicateIds } = adaptDeals([row({}), row({ OPPORTUNITY: '999' })], BYN)
    expect(deals).toHaveLength(1)
    expect(duplicateIds).toBe(1)
  })

  // Выборка уже отфильтрована по LEAD_ID — сделка без лида здесь означает, что фильтр поехал.
  it('сделку без лида считает отдельно', () => {
    expect(adaptDeals([row({ LEAD_ID: null })], BYN).dealsWithoutLead).toBe(1)
  })

  /**
   * ⚠ Это боевой путь: композабл зовёт `adaptDeals` с картой ключей из ОДНОГО `mergeReasons`.
   * Без этого теста «упрощение» обратно к коду стадии оставило бы сделки под кодами, а словарь —
   * под ключами: каждая строка причин печаталась бы сырым кодом, и вся выборка оставалась зелёной.
   */
  it('помечает проигранные сделки каноничным ключом из переданной карты', () => {
    const stages = [
      { STATUS_ID: 'LOSE', NAME: 'Отказ - Дорого', SEMANTICS: 'F' },
      { STATUS_ID: 'C1:LOSE', NAME: 'Отказ - дорого', SEMANTICS: 'F' }
    ]
    const reasons = mergeReasons(lossStages(stages))
    const { deals } = adaptDeals([
      row({ ID: '1', STAGE_ID: 'LOSE', STAGE_SEMANTIC_ID: 'F' }),
      row({ ID: '2', STAGE_ID: 'C1:LOSE', STAGE_SEMANTIC_ID: 'F' })
    ], BYN, reasons.keyByCode)
    expect(deals[0]!.lossReasonId).toBe(deals[1]!.lossReasonId)
    expect(reasons.names[deals[0]!.lossReasonId!]).toBe('Отказ - Дорого')
  })

  it('стадия, которой нет в карте, остаётся кодом — его хотя бы можно найти в CRM', () => {
    const { deals } = adaptDeals([row({ STAGE_ID: 'C9:LOSE', STAGE_SEMANTIC_ID: 'F' })], BYN, {})
    expect(deals[0]!.lossReasonId).toBe('C9:LOSE')
  })

  // ⚠ На портале заказчика ВСЕ успешные сделки из лидов с нулём — это факт о процессе в CRM, и
  // «выручка 0» без этого счётчика читалась бы как поломка отчёта.
  it('успешную сделку с нулевой суммой считает отдельно', () => {
    const { wonWithoutAmount } = adaptDeals([row({ OPPORTUNITY: '0.00' }), row({ ID: '2' })], BYN)
    expect(wonWithoutAmount).toBe(1)
  })

  it('валюту без курса не конвертирует и считает', () => {
    const { deals, unconvertedDeals } = adaptDeals([row({ CURRENCY_ID: 'XYZ' })], BYN)
    expect(deals[0]?.amount).toBe(100)
    expect(unconvertedDeals).toBe(1)
  })
})

describe('lossStages', () => {
  // ⚠ «Новая» и «Успех» тоже продублированы по направлениям. Сведи мы весь справочник, счётчик
  // «стадий свёрнуто» на экране был бы втрое больше правды и не сходился бы ни с чем.
  it('оставляет только стадии провала', () => {
    const rows = [
      { STATUS_ID: 'NEW', NAME: 'Новая', SEMANTICS: null },
      { STATUS_ID: 'C1:NEW', NAME: 'Новая', SEMANTICS: null },
      { STATUS_ID: 'WON', NAME: 'Успех', SEMANTICS: 'S' },
      { STATUS_ID: 'C1:WON', NAME: 'Успех', SEMANTICS: 'S' },
      { STATUS_ID: 'LOSE', NAME: 'Отказ - дорого', SEMANTICS: 'F' },
      { STATUS_ID: 'C1:LOSE', NAME: 'Отказ - дорого', SEMANTICS: 'f' }
    ]
    expect(lossStages(rows).map(r => r.STATUS_ID)).toEqual(['LOSE', 'C1:LOSE'])
    expect(mergeReasons(lossStages(rows)).foldedCodes).toBe(1)
    expect(mergeReasons(rows).foldedCodes).toBe(3)
  })
})

describe('успешные сделки без связи с лидом', () => {
  const period = { from: '2026-08-01', to: '2026-08-31' }
  const currencies = [{ CURRENCY: 'BYN', BASE: 'Y' }, { CURRENCY: 'RUB', AMOUNT: '3.5', AMOUNT_CNT: '100' }]

  // ⚠ Период — по ДАТЕ ЗАКРЫТИЯ, не по созданию: решение владельца от 2026-09-04. `LEAD_ID: ''` —
  // так портал понимает «поле пусто»; семантика S — только успешные.
  it('запрос: успешные, без лида, по CLOSEDATE, верхняя граница строгая', () => {
    const params = unlinkedWonDealsParams(period)
    expect(params.filter).toEqual({ '>=CLOSEDATE': '2026-08-01', '<CLOSEDATE': '2026-09-01', 'LEAD_ID': '', 'STAGE_SEMANTIC_ID': 'S' })
    expect(params.select).toEqual(['ID', 'SOURCE_ID', 'OPPORTUNITY', 'CURRENCY_ID'])
    expect(params.filter).not.toHaveProperty('>=DATE_CREATE')
  })

  it('строки по источникам, пустой источник — своя строка, суммы и доли от итога', () => {
    const rows = [
      { ID: '1', SOURCE_ID: 'CALL', OPPORTUNITY: '100', CURRENCY_ID: 'BYN' },
      { ID: '2', SOURCE_ID: '', OPPORTUNITY: '700', CURRENCY_ID: 'BYN' },
      { ID: '3', SOURCE_ID: null, OPPORTUNITY: '200', CURRENCY_ID: 'BYN' },
      { ID: '4', SOURCE_ID: 'CALL', OPPORTUNITY: '0', CURRENCY_ID: 'BYN' }
    ]
    const result = adaptUnlinkedWonDeals(rows, currencies, ['CALL'])
    expect(result.total).toBe(4)
    expect(result.revenue).toBe(1000)
    expect(result.unconverted).toBe(0)
    expect(result.totalShareOfRevenue).toBe(1)
    // Сортировка по сумме: «не указан» (900) выше CALL (100), хотя сделок у обоих по две.
    expect(result.rows.map(r => [r.sourceId, r.count, r.revenue])).toEqual([
      [UNSPECIFIED_SOURCE, 2, 900],
      ['CALL', 2, 100]
    ])
    expect(result.rows[0]!.share).toBeCloseTo(0.5, 6)
    expect(result.rows[0]!.shareOfRevenue).toBeCloseTo(0.9, 6)
    expect(result.rows.reduce((sum, r) => sum + r.count, 0)).toBe(result.total)
    expect(result.rows.reduce((sum, r) => sum + r.revenue, 0)).toBeCloseTo(result.revenue, 6)
  })

  // ⚠ Та же конвертация, что у сделок из лидов: курс есть — приводим, курса нет — как есть и в оговорку.
  it('чужая валюта: с курсом приводится, без курса остаётся как есть и считается', () => {
    const rows = [
      { ID: '1', SOURCE_ID: 'CALL', OPPORTUNITY: '100', CURRENCY_ID: 'RUB' },
      { ID: '2', SOURCE_ID: 'CALL', OPPORTUNITY: '50', CURRENCY_ID: 'USD' }
    ]
    const result = adaptUnlinkedWonDeals(rows, currencies, ['CALL'])
    expect(result.revenue).toBeCloseTo(100 * 0.035 + 50, 6)
    expect(result.unconverted).toBe(1)
  })

  // ⚠ Подпись строки обещает «не указан ИЛИ удалён из справочника» — код, которого в справочнике
  // нет, обязан попасть в неё, а не печататься голым кодом отдельной строкой.
  it('источник, удалённый из справочника, идёт в строку «не указан»', () => {
    const rows = [
      { ID: '1', SOURCE_ID: 'UC_OLD', OPPORTUNITY: '10' },
      { ID: '2', SOURCE_ID: '', OPPORTUNITY: '20' },
      { ID: '3', SOURCE_ID: 'CALL', OPPORTUNITY: '30' }
    ]
    const result = adaptUnlinkedWonDeals(rows, currencies, ['CALL'])
    expect(result.rows.map(r => [r.sourceId, r.count, r.revenue])).toEqual([[UNSPECIFIED_SOURCE, 2, 30], ['CALL', 1, 30]])
  })

  it('нулевая сумма: доли строк и подвала — нули, а не 100 % против нулей', () => {
    const result = adaptUnlinkedWonDeals([{ ID: '1', SOURCE_ID: 'CALL', OPPORTUNITY: '0' }], currencies, ['CALL'])
    expect(result.rows[0]!.shareOfRevenue).toBe(0)
    expect(result.totalShareOfRevenue).toBe(0)
    expect(result.rows[0]!.share).toBe(1)
  })

  it('повторы по ID отбрасываются, пустой список — нули без строк', () => {
    const rows = [{ ID: '7', SOURCE_ID: 'CALL', OPPORTUNITY: '10' }, { ID: 7, SOURCE_ID: 'CALL', OPPORTUNITY: '10' }]
    expect(adaptUnlinkedWonDeals(rows, currencies, ['CALL']).total).toBe(1)
    expect(adaptUnlinkedWonDeals([], currencies)).toEqual({ total: 0, revenue: 0, unconverted: 0, totalShareOfRevenue: 0, rows: [] })
  })
})
