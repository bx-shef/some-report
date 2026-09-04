import { describe, expect, it } from 'vitest'
import { adaptLeadCounts, adaptUsers, leadCountKey } from '~/utils/b24Adapter'
import { dealsFromLeadsParams, leadCountBatch, leadHistoryLeadParams, leadIdsParams, userListParams } from '~/utils/b24Query'
import {
  EMPTY_FILTERS,
  applyFilters,
  chunkIds,
  codesByReason,
  dealRestFilter,
  hasFilters,
  leadRestFilter,
  leadStatusFilter,
  lockedFilterValue,
  needsLeadIds
} from '~/utils/filters'
import { buildMockDataset } from '~/utils/mockReport'
import { buildReport } from '~/utils/metrics'

/**
 * Фильтры отчёта: что они значат для запросов к порталу и для строк демо-набора.
 *
 * ⚠ Главная ловушка — сделка не знает менеджера и стадию лида. Фильтр по ним ложится на сделки
 * только через список ID лидов, и пустой список обязан дать «сделок нет», а не «все сделки».
 */
const AUGUST = { from: '2026-08-01', to: '2026-08-31' }

describe('фрагменты REST-фильтра', () => {
  it('пустые фильтры — пустой фрагмент, без ключей с пустыми значениями', () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false)
    expect(hasFilters({ assignedById: 0 })).toBe(false)
    expect(hasFilters({ assignedById: Number.NaN })).toBe(false)
    expect(leadRestFilter({ sourceId: '', assignedById: 0 })).toEqual({})
    expect(needsLeadIds({ sourceId: 'CALL' })).toBe(false)
    expect(needsLeadIds({ assignedById: 0 })).toBe(false)
  })

  it('закреплённое фильтром поле — строкой; пустое или отсутствующее — не закреплено', () => {
    expect(lockedFilterValue({ STATUS_ID: 'JUNK' }, 'STATUS_ID')).toBe('JUNK')
    expect(lockedFilterValue({ ASSIGNED_BY_ID: 562 }, 'STATUS_ID')).toBeUndefined()
    expect(lockedFilterValue({ SOURCE_ID: '' }, 'SOURCE_ID')).toBeUndefined()
  })

  it('источник и менеджер — поля лида; стадия и причина брака — одно поле STATUS_ID, причина точнее', () => {
    expect(leadRestFilter({ sourceId: 'CALL', assignedById: 562 })).toEqual({ SOURCE_ID: 'CALL', ASSIGNED_BY_ID: 562 })
    expect(leadStatusFilter({ leadStatusId: '1', junkReasonId: 'JUNK' })).toBe('JUNK')
    expect(leadRestFilter({ leadStatusId: '1' })).toEqual({ STATUS_ID: '1' })
    expect(needsLeadIds({ assignedById: 562 })).toBe(true)
    expect(needsLeadIds({ junkReasonId: 'JUNK' })).toBe(true)
  })

  it('у сделки — источник и стадии проигрыша по каноничному ключу; удалённая причина — заведомо пусто', () => {
    const codes = codesByReason({ 'LOSE': 'дорого', 'C2:LOSE': 'дорого', 'C2:APOLOGY': 'не отвечает' })
    expect(codes).toEqual({ 'дорого': ['LOSE', 'C2:LOSE'], 'не отвечает': ['C2:APOLOGY'] })
    expect(dealRestFilter({ sourceId: 'CALL', lossReasonKey: 'дорого' }, codes)).toEqual({ SOURCE_ID: 'CALL', STAGE_ID: ['LOSE', 'C2:LOSE'] })
    expect(dealRestFilter({ lossReasonKey: 'нет такой' }, codes)).toEqual({ STAGE_ID: ['__no_such_stage__'] })
  })

  it('список ID режется кусками по 500', () => {
    const ids = Array.from({ length: 1201 }, (_, i) => i + 1)
    const chunks = chunkIds(ids)
    expect(chunks.map(c => c.length)).toEqual([500, 500, 201])
    expect(chunkIds([])).toEqual([])
  })
})

describe('параметры запросов под фильтром', () => {
  it('счётчики лидов получают фильтр во ВСЕ команды, включая «не обработано» и стадии', () => {
    const commands = leadCountBatch(AUGUST, { junkStatusIds: ['JUNK'], sourceIds: ['CALL'], openStatusIds: ['NEW', '1'] }, { ASSIGNED_BY_ID: 562 })
    for (const [key, command] of Object.entries(commands)) {
      expect(command.params.filter, key).toMatchObject({ ASSIGNED_BY_ID: 562 })
    }
    expect(commands[leadCountKey.unprocessed]!.params.filter).toMatchObject({ STATUS_ID: 'NEW', ASSIGNED_BY_ID: 562 })
  })

  // ⚠ Фильтр и пофакторная команда пишут в одно поле: `{ ...base, SOURCE_ID: 'EMAIL' }` при фильтре
  // CALL молча заменял бы условие, и таблица источников считалась бы по всем лидам.
  it('под фильтром по источнику команды о других источниках не шлются, свой — с фильтром', () => {
    const commands = leadCountBatch(AUGUST, { junkStatusIds: ['JUNK'], sourceIds: ['CALL', 'EMAIL'], openStatusIds: ['NEW', '1'] }, { SOURCE_ID: 'CALL' })
    expect(commands[leadCountKey.source('CALL')]!.params.filter).toEqual({ '>=DATE_CREATE': '2026-08-01', '<DATE_CREATE': '2026-09-01', 'SOURCE_ID': 'CALL' })
    expect(commands).not.toHaveProperty(leadCountKey.source('EMAIL'))
    expect(commands).not.toHaveProperty(leadCountKey.sourceJunk('EMAIL'))
    // Стадии фильтром не закреплены — спрашиваются все, и все под фильтром источника.
    expect(commands[leadCountKey.unprocessed]!.params.filter).toMatchObject({ SOURCE_ID: 'CALL', STATUS_ID: 'NEW' })
    expect(commands[leadCountKey.stage('1')]!.params.filter).toMatchObject({ SOURCE_ID: 'CALL', STATUS_ID: '1' })
  })

  it('под фильтром по стадии брака: ни «не обработано», ни других причин, ни открытых стадий', () => {
    const commands = leadCountBatch(AUGUST, { junkStatusIds: ['JUNK', 'OTHER'], sourceIds: ['CALL'], openStatusIds: ['NEW', '1'] }, { STATUS_ID: 'JUNK' })
    expect(commands[leadCountKey.junkReason('JUNK')]!.params.filter).toMatchObject({ STATUS_ID: 'JUNK' })
    expect(commands).not.toHaveProperty(leadCountKey.junkReason('OTHER'))
    expect(commands).not.toHaveProperty(leadCountKey.unprocessed)
    expect(commands).not.toHaveProperty(leadCountKey.stage('1'))
    // Источники не закреплены — под фильтром стадии спрашиваются как обычно.
    expect(commands[leadCountKey.source('CALL')]!.params.filter).toMatchObject({ STATUS_ID: 'JUNK', SOURCE_ID: 'CALL' })
    // Фильтр по самой NEW — «не обработано» спрашивается, это и есть всего.
    expect(leadCountBatch(AUGUST, { junkStatusIds: [], sourceIds: [] }, { STATUS_ID: 'NEW' })).toHaveProperty(leadCountKey.unprocessed)
  })

  it('адаптер: под фильтром по стадии брака «не обработано» — ноль, а не «не считали»', () => {
    const totals = { [leadCountKey.total]: 5, [leadCountKey.junk]: 5, [leadCountKey.junkReason('JUNK')]: 5 }
    const filtered = adaptLeadCounts({ totals, sourceIds: [], junkStatusIds: ['JUNK', 'OTHER'], openStatusIds: ['NEW', '1'], leadFilter: { STATUS_ID: 'JUNK' } })
    expect(filtered.unprocessed).toBe(0)
    expect(filtered.processing).toMatchObject({ processed: 5, unprocessed: 0 })
    expect(filtered.junkByReason).toEqual({ JUNK: 5 })
    // Без фильтра отсутствующий счётчик по-прежнему значит «не считали».
    expect(adaptLeadCounts({ totals, sourceIds: [], junkStatusIds: ['JUNK'] }).unprocessed).toBeUndefined()
  })

  it('строки лидов для истории и список ID — под тем же фильтром', () => {
    expect(leadHistoryLeadParams(AUGUST, { SOURCE_ID: 'CALL' }).filter).toMatchObject({ 'SOURCE_ID': 'CALL', '>=DATE_CREATE': '2026-08-01' })
    expect(leadIdsParams(AUGUST, { STATUS_ID: 'JUNK' })).toEqual({ select: ['ID'], filter: { '>=DATE_CREATE': '2026-08-01', '<DATE_CREATE': '2026-09-01', 'STATUS_ID': 'JUNK' } })
  })

  it('сделки из лидов: без списка — «лид есть»; со списком — по нему; пустой список — ошибка, не «все сделки»', () => {
    expect(dealsFromLeadsParams(AUGUST).filter).toMatchObject({ '!LEAD_ID': null })
    expect(dealsFromLeadsParams(AUGUST, { SOURCE_ID: 'CALL' }, [7, 9]).filter).toMatchObject({ LEAD_ID: [7, 9], SOURCE_ID: 'CALL' })
    expect(dealsFromLeadsParams(AUGUST, {}, [7]).filter).not.toHaveProperty('!LEAD_ID')
    // ⚠ `LEAD_ID: [0]` на боевом портале отдаёт сделки БЕЗ лида — пустой список запрещён.
    expect(() => dealsFromLeadsParams(AUGUST, {}, [])).toThrow('пустой список')
  })

  it('сотрудники — активные штатные, по ID, страницами через start', () => {
    expect(userListParams()).toEqual({ sort: 'ID', order: 'ASC', FILTER: { ACTIVE: true, USER_TYPE: 'employee' }, start: 0 })
    expect(userListParams(50).start).toBe(50)
  })
})

describe('adaptUsers', () => {
  it('«Фамилия Имя»; без имени — «Сотрудник #id»; мусорные ID отбрасываются', () => {
    expect(adaptUsers([
      { ID: '562', NAME: 'Анна', LAST_NAME: 'Иванова' },
      { ID: 7, NAME: ' ', LAST_NAME: null },
      { ID: 'abc', NAME: 'X' },
      { ID: '0', NAME: 'Y' }
    ])).toEqual({ 562: 'Иванова Анна', 7: 'Сотрудник #7' })
  })
})

describe('applyFilters (демо-набор)', () => {
  const dataset = buildMockDataset()
  const options = { conversionBase: 'quality-leads' as const, firstResponseSlaMinutes: 120 }

  it('без фильтров — те же строки, тот же объект', () => {
    const rows = applyFilters(dataset.leads, dataset.deals, {})
    expect(rows.leads).toBe(dataset.leads)
    expect(rows.deals).toBe(dataset.deals)
  })

  it('источник — у лидов и сделок свой; сводка считает только его', () => {
    const [sourceId] = Object.keys(dataset.dictionaries.sources)
    const rows = applyFilters(dataset.leads, dataset.deals, { sourceId })
    expect(rows.leads.every(l => l.sourceId === sourceId)).toBe(true)
    expect(rows.deals.every(d => d.sourceId === sourceId)).toBe(true)
    const report = buildReport(rows.leads, rows.deals, options)
    const full = buildReport(dataset.leads, dataset.deals, options)
    expect(report.summary.totalLeads).toBe(full.bySource.find(r => r.sourceId === sourceId)!.leads)
    expect(report.summary.totalLeads).toBeLessThan(full.summary.totalLeads)
  })

  it('менеджер — по лиду: сделка остаётся, только если остался её лид', () => {
    const rows = applyFilters(dataset.leads, dataset.deals, { assignedById: 2 })
    expect(rows.leads.length).toBeGreaterThan(0)
    expect(rows.leads.every(l => l.assignedById === 2)).toBe(true)
    const ids = new Set(rows.leads.map(l => l.id))
    expect(rows.deals.length).toBeGreaterThan(0)
    expect(rows.deals.every(d => d.leadId !== undefined && ids.has(d.leadId))).toBe(true)
  })

  it('причина брака — только такие лиды; причина проигрыша — только такие сделки, лиды не режутся', () => {
    const [junkId] = Object.keys(dataset.dictionaries.junkReasons)
    const junk = applyFilters(dataset.leads, dataset.deals, { junkReasonId: junkId })
    expect(junk.leads.every(l => l.outcome === 'junk' && l.junkReasonId === junkId)).toBe(true)
    expect(junk.deals).toEqual([])

    const [lossId] = Object.keys(dataset.dictionaries.lossReasons)
    const lost = applyFilters(dataset.leads, dataset.deals, { lossReasonKey: lossId })
    expect(lost.leads).toHaveLength(dataset.leads.length)
    expect(lost.deals.every(d => d.lossReasonId === lossId)).toBe(true)
    expect(lost.deals.length).toBeGreaterThan(0)
  })

  it('стадия лида выводится из исхода: CONVERTED — со сделкой; открытых в демо-наборе нет вовсе', () => {
    const converted = applyFilters(dataset.leads, dataset.deals, { leadStatusId: 'CONVERTED' })
    expect(converted.leads.length).toBe(dataset.leads.filter(l => l.outcome === 'converted').length)
    expect(converted.leads.every(l => l.outcome === 'converted')).toBe(true)
    expect(converted.deals.length).toBe(dataset.deals.length)
    // «Не обработан» — лид без первого ответа, как считает ядро: фильтр обязан сходиться с
    // числом «не обработано» блока 6 на одном экране. Макет: 1 250 лидов = 250 брака + 1 000
    // сконвертированных, «в работе» никого — стадия «В работе» в предпросмотре честно пуста.
    const fresh = applyFilters(dataset.leads, dataset.deals, { leadStatusId: 'NEW' }).leads
    expect(fresh.length).toBe(dataset.leads.filter(l => !l.firstResponseAt).length)
    expect(fresh.length).toBeGreaterThan(0)
    expect(applyFilters(dataset.leads, dataset.deals, { leadStatusId: '1' }).leads).toEqual([])
  })

  // «Потерян» — стадия успеха без сделки: по коду это CONVERTED, как и у сконвертированного.
  it('стадия CONVERTED — и сконвертированные, и потерянные без сделки', () => {
    const lead = { ...dataset.leads[0]!, id: 999_999, outcome: 'lost' as const, dealIds: [] }
    const rows = applyFilters([lead], [], { leadStatusId: 'CONVERTED' })
    expect(rows.leads.map(l => l.id)).toEqual([999_999])
    expect(applyFilters([lead], [], { leadStatusId: 'NEW' }).leads).toEqual([])
  })

  it('стадия лида и причина брака вместе — побеждает причина', () => {
    const [junkId] = Object.keys(dataset.dictionaries.junkReasons)
    const rows = applyFilters(dataset.leads, dataset.deals, { leadStatusId: 'CONVERTED', junkReasonId: junkId })
    expect(rows.leads.every(l => l.junkReasonId === junkId)).toBe(true)
  })
})
