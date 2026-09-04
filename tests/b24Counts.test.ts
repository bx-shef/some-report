import { describe, expect, it } from 'vitest'
import { adaptDealsContext, adaptLeadCounts, dealCountKey, leadCountKey, statusIdsBySemantic } from '~/utils/b24Adapter'
import { dealContextBatch, dealStageBatch, dealsFromLeadsParams, leadCountBatch } from '~/utils/b24Query'
import { UNSPECIFIED_SOURCE } from '~/utils/metrics'

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
