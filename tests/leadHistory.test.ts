import { describe, expect, it } from 'vitest'
import { INITIAL_LEAD_STATUS, leadsFromHistory } from '~/utils/leadHistory'
import { leadCreatedInStageParams, leadHistoryLeadParams, leadHistoryParams } from '~/utils/b24Query'
import { openLeadStatusIds } from '~/utils/b24Adapter'
import { leadStageLabel } from '~/utils/labels'
import { mergeProcessing, preDealLoss, processingFromCounts, processingMetrics, summaryMetrics } from '~/utils/metrics'

/**
 * Первый ответ по лиду — первый уход со стадии «Не обработан» (решение владельца от 2026-09-04).
 * Здесь сторожим сборку строк лидов из истории и то, что ядро считает по ним ровно то же, что по
 * демо-набору: формулы одни, вход разный.
 */
const AUGUST = { from: '2026-08-01', to: '2026-08-31' }

describe('leadHistoryParams', () => {
  it('переходы и закрытия с начала периода и с запасом после его конца, только для лидов', () => {
    const params = leadHistoryParams(AUGUST, 3)
    expect(params.entityTypeId).toBe(1)
    expect(params.filter).toEqual({ '>=CREATED_TIME': '2026-08-01', '<CREATED_TIME': '2026-09-04', 'TYPE_ID': [2, 3] })
    expect(params.select).toEqual(['ID', 'TYPE_ID', 'OWNER_ID', 'CREATED_TIME', 'STATUS_ID'])
  })

  // Запас через границу года: 31 декабря + 3 дня = 3 января, верхняя граница строгая — 4 января.
  it('запас после конца периода считается по календарю, через границу года тоже', () => {
    expect(leadHistoryParams({ from: '2026-12-01', to: '2026-12-31' }, 3).filter).toMatchObject({ '<CREATED_TIME': '2027-01-04' })
  })

  it('созданные сразу в стадии не-NEW — отдельным запросом за сам период', () => {
    const params = leadCreatedInStageParams(AUGUST)
    expect(params.filter).toEqual({ '>=CREATED_TIME': '2026-08-01', '<CREATED_TIME': '2026-09-01', 'TYPE_ID': 1, '!STATUS_ID': 'NEW' })
  })

  it('нераспознанный период — ошибка, а не фильтр NaN-NaN-NaN', () => {
    expect(() => leadHistoryParams({ from: '2026-08-01', to: '' })).toThrow('не распознан')
  })

  it('строки лидов для истории — по периоду создания, с источником и стадией', () => {
    const params = leadHistoryLeadParams(AUGUST)
    expect(params.filter).toEqual({ '>=DATE_CREATE': '2026-08-01', '<DATE_CREATE': '2026-09-01' })
    expect(params.select).toEqual(['ID', 'DATE_CREATE', 'SOURCE_ID', 'STATUS_ID'])
  })
})

describe('leadsFromHistory', () => {
  const leads = [
    { ID: '1', DATE_CREATE: '2026-08-10T10:00:00+03:00', SOURCE_ID: 'CALL', STATUS_ID: '1' },
    { ID: '2', DATE_CREATE: '2026-08-10T11:00:00+03:00', SOURCE_ID: '', STATUS_ID: 'JUNK' },
    { ID: '3', DATE_CREATE: '2026-08-10T12:00:00+03:00', SOURCE_ID: 'WEB', STATUS_ID: INITIAL_LEAD_STATUS },
    { ID: 3, DATE_CREATE: '2026-08-10T12:00:00+03:00', SOURCE_ID: 'WEB', STATUS_ID: INITIAL_LEAD_STATUS }
  ]
  const history = [
    // Лид 1: два перехода — считается самый ранний, а не первый по порядку в ответе.
    { ID: '12', TYPE_ID: 2, OWNER_ID: '1', CREATED_TIME: '2026-08-10T12:30:00+03:00', STATUS_ID: '1' },
    { ID: '11', TYPE_ID: 2, OWNER_ID: '1', CREATED_TIME: '2026-08-10T10:30:00+03:00', STATUS_ID: '1' },
    // Лид 2 сразу в брак, минуя «взято в работу», — всё равно обработан.
    { ID: '13', TYPE_ID: 3, OWNER_ID: '2', CREATED_TIME: '2026-08-10T11:05:00+03:00', STATUS_ID: 'JUNK' },
    // Запись про NEW — не ответ, даже если она в истории.
    { ID: '14', TYPE_ID: 1, OWNER_ID: '3', CREATED_TIME: '2026-08-10T12:00:00+03:00', STATUS_ID: INITIAL_LEAD_STATUS },
    // Переход чужого лида (не из периода) — отбрасывается.
    { ID: '15', TYPE_ID: 2, OWNER_ID: '99', CREATED_TIME: '2026-08-10T12:00:00+03:00', STATUS_ID: '1' }
  ]

  it('строит лиды с первым уходом из NEW; повторы лидов отбрасывает', () => {
    const result = leadsFromHistory(leads, history, ['JUNK'], ['CONVERTED'])
    expect(result.map(l => [l.id, l.firstResponseAt, l.outcome])).toEqual([
      [1, '2026-08-10T10:30:00+03:00', 'in-work'],
      [2, '2026-08-10T11:05:00+03:00', 'junk'],
      [3, undefined, 'in-work']
    ])
    expect(result[1]!.junkReasonId).toBe('JUNK')
    expect(result[0]!.sourceId).toBe('CALL')
  })

  // Лид, созданный сразу «в работу»: перехода нет, есть запись создания со стадией — ответ в
  // момент создания, ноль минут. Иначе он был бы просрочен по истории и обработан по счётчику.
  it('создание сразу в стадии не-NEW — ответ в момент создания', () => {
    const created = [{ ID: '20', TYPE_ID: 1, OWNER_ID: '7', CREATED_TIME: '2026-08-11T09:00:00+03:00', STATUS_ID: '1' }]
    const rows = leadsFromHistory([{ ID: '7', DATE_CREATE: '2026-08-11T09:00:00+03:00', SOURCE_ID: 'WEB', STATUS_ID: '1' }], created)
    expect(rows[0]!.firstResponseAt).toBe('2026-08-11T09:00:00+03:00')
  })

  it('ядро считает по этим строкам обработанных, среднее и просрочку как по демо-набору', () => {
    const rows = leadsFromHistory(leads, history, ['JUNK'])
    const metrics = processingMetrics(rows, { conversionBase: 'quality-leads', firstResponseSlaMinutes: 120, now: '2026-08-10T15:00:00+03:00' })
    expect(metrics.processed).toBe(2)
    expect(metrics.unprocessed).toBe(1)
    // 30 минут и 5 минут → в среднем 17,5.
    expect(metrics.avgFirstResponseMinutes).toBeCloseTo(17.5, 6)
    // Лид 3 без ответа три часа — просрочен по нормативу 120 минут.
    expect(metrics.overdue).toBe(1)
    expect(metrics.bySource.map(r => r.sourceId)).toEqual(expect.arrayContaining(['CALL']))
  })
})

describe('processingFromCounts и mergeProcessing', () => {
  it('обработано = всего − в «Не обработан», доли от всего, время пусто', () => {
    const counts = processingFromCounts(3851, 2)
    expect(counts.processed).toBe(3849)
    expect(counts.processedShare).toBeCloseTo(3849 / 3851, 6)
    expect(counts.unprocessed).toBe(2)
    expect(counts.avgFirstResponseMinutes).toBeUndefined()
    expect(counts.overdue).toBeUndefined()
  })

  it('не верит счётчику «не обработано» больше, чем «всего», и не уходит в минус', () => {
    expect(processingFromCounts(5, 9)).toMatchObject({ processed: 0, unprocessed: 5 })
    expect(processingFromCounts(0, 0)).toMatchObject({ processed: 0, unprocessed: 0, processedShare: 0 })
  })

  // ⚠ Числа «обработано» — от счётчиков (они уже на экране), время и разрез — из истории.
  // Иначе два разных «обработано» под одной подписью с интервалом в минуту.
  it('совмещение: числа от счётчиков, время, просрочка и источники — из истории', () => {
    const counts = processingFromCounts(100, 10)
    const timed = { ...processingFromCounts(98, 9), overdue: 7, overdueShare: 7 / 98, avgFirstResponseMinutes: 42, bySource: [{ sourceId: 'CALL', processed: 50, avgFirstResponseMinutes: 40 }] }
    const merged = mergeProcessing(counts, timed)
    expect(merged.processed).toBe(90)
    expect(merged.unprocessed).toBe(10)
    expect(merged.overdue).toBe(7)
    // Доля просроченных — от «всего» счётчиков (100), а не от строк истории (98).
    expect(merged.overdueShare).toBeCloseTo(0.07, 6)
    expect(merged.avgFirstResponseMinutes).toBe(42)
    expect(merged.bySource).toHaveLength(1)
  })
})

describe('открытые стадии лида', () => {
  const rows = [
    { STATUS_ID: 'NEW', NAME: 'Новая заявка', SEMANTICS: null },
    { STATUS_ID: '1', NAME: 'Взято в работу', SEMANTICS: '' },
    { STATUS_ID: 'CONVERTED', NAME: 'Квалифицировано', SEMANTICS: 'S' },
    { STATUS_ID: 'JUNK', NAME: 'Брак', SEMANTICS: 'F' }
  ]

  it('открытые — без семантики успеха и провала, включая NEW', () => {
    expect(openLeadStatusIds(rows)).toEqual(['NEW', '1'])
  })

  it('подпись стадии — из справочника, неизвестный код — как есть', () => {
    const dictionaries = { sources: {}, junkReasons: {}, lossReasons: {}, leadStages: { 1: 'Взято в работу' } }
    expect(leadStageLabel(dictionaries, '1')).toBe('Взято в работу')
    expect(leadStageLabel(dictionaries, 'UC_X')).toBe('UC_X')
    expect(leadStageLabel({ sources: {}, junkReasons: {}, lossReasons: {} }, '1')).toBe('1')
  })

  it('потери до сделки: открытые лиды по стадиям — по убыванию, потом по коду; без счётчиков поля нет', () => {
    const aggregate = {
      total: 10, junk: 2, qualified: 3, inWork: 5, closedWithoutDeal: 0,
      junkByReason: {}, bySource: {}, byOpenStage: { NEW: 1, 1: 3, B: 1 }
    }
    const summary = summaryMetrics(aggregate, [], { conversionBase: 'quality-leads' })
    expect(preDealLoss(aggregate, summary).byStage).toEqual([{ stageId: '1', count: 3 }, { stageId: 'B', count: 1 }, { stageId: 'NEW', count: 1 }])
    expect(preDealLoss({ ...aggregate, byOpenStage: undefined }, summary).byStage).toBeUndefined()
  })
})
