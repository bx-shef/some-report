import { describe, expect, it } from 'vitest'
import { INITIAL_LEAD_STATUS, leadsFromHistory } from '~/utils/leadHistory'
import { leadHistoryLeadParams, leadHistoryParams } from '~/utils/b24Query'
import { mergeProcessing, processingFromCounts, processingMetrics } from '~/utils/metrics'

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
    const timed = { ...processingFromCounts(98, 9), overdue: 7, overdueShare: 0.07, avgFirstResponseMinutes: 42, bySource: [{ sourceId: 'CALL', processed: 50, avgFirstResponseMinutes: 40 }] }
    const merged = mergeProcessing(counts, timed)
    expect(merged.processed).toBe(90)
    expect(merged.unprocessed).toBe(10)
    expect(merged.overdue).toBe(7)
    expect(merged.avgFirstResponseMinutes).toBe(42)
    expect(merged.bySource).toHaveLength(1)
  })
})
