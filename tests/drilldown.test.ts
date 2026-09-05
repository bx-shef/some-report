import { describe, expect, it } from 'vitest'
import { crmPath, dealDrillRow, demoDrillRows, drill, drillListParams, leadDrillRow, plainDealListParams } from '~/utils/drilldown'
import { UNSPECIFIED_REASON, UNSPECIFIED_SOURCE, buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Детализация по клику: список обязан сходиться с числом, по которому нажали, — тем же
 * условием. Числа, за которыми такого условия нет, некликабельны.
 */
const AUGUST = { from: '2026-08-01', to: '2026-08-31' }
const dataset = buildMockDataset()
const dictionaries = { ...dataset.dictionaries, lossReasonCodes: { дорого: ['LOSE', 'C2:LOSE'] } }

describe('drill: что за числом', () => {
  it('лиды — по семантике и стадии; «источник не указан» и «причина не указана» — честно', () => {
    expect(drill.junk().extra).toEqual({ STATUS_SEMANTIC_ID: 'F' })
    expect(drill.unprocessed().extra).toEqual({ STATUS_ID: 'NEW' })
    expect(drill.processed().extra).toEqual({ '!STATUS_ID': 'NEW' })
    expect(drill.junkReason('JUNK', 'Спам', ['JUNK', 'OTHER'])).toMatchObject({ entity: 'lead', title: 'Брак лидов: Спам', extra: { STATUS_ID: 'JUNK' } })
    expect(drill.junkReason(UNSPECIFIED_REASON, 'Не указана', ['JUNK']).extra).toEqual({ 'STATUS_SEMANTIC_ID': 'F', '!STATUS_ID': ['JUNK'] })
    expect(drill.junkReason(UNSPECIFIED_REASON, 'Не указана', []).extra).toEqual({ STATUS_SEMANTIC_ID: 'F' })
    expect(drill.bySource(UNSPECIFIED_SOURCE, 'leads', 'Не указан')).toBeUndefined()
    expect(drill.bySource('CALL', 'won', 'Звонок')).toMatchObject({ entity: 'deal', dealScope: 'from-leads', extra: { SOURCE_ID: 'CALL', STAGE_SEMANTIC_ID: 'S' } })
  })

  it('сделки — причина проигрыша всеми кодами; удалённая — заведомо пусто; блок 7 — без лида', () => {
    expect(drill.lossReason('дорого', 'Дорого', dictionaries.lossReasonCodes).extra).toEqual({ STAGE_ID: ['LOSE', 'C2:LOSE'] })
    expect(drill.lossReason('C3:LOSE', 'C3:LOSE', dictionaries.lossReasonCodes).extra).toEqual({ STAGE_ID: ['C3:LOSE'] })
    expect(drill.lossReason(UNSPECIFIED_REASON, 'Не указана', dictionaries.lossReasonCodes).extra).toEqual({ 'STAGE_SEMANTIC_ID': 'F', '!STAGE_ID': ['LOSE', 'C2:LOSE'] })
    expect(drill.unlinked()).toMatchObject({ entity: 'deal', dealScope: 'unlinked' })
    expect(drill.unlinkedSource(UNSPECIFIED_SOURCE, 'Не указан')).toBeUndefined()
  })
})

describe('drillListParams', () => {
  it('лиды: период → фильтры отчёта → условие числа', () => {
    const params = drillListParams(drill.junkReason('JUNK', 'Спам', []), AUGUST, { sourceId: 'CALL' }, {})
    expect(params.method).toBe('crm.lead.list')
    expect(params.filter).toEqual({ '>=DATE_CREATE': '2026-08-01', '<DATE_CREATE': '2026-09-01', 'SOURCE_ID': 'CALL', 'STATUS_ID': 'JUNK' })
    expect(params.select).toContain('TITLE')
    expect(params.byLeadIds).toBe(false)
  })

  it('сделки из лидов: без фильтра по лиду — «лид есть», с ним — по списку ID у композабла', () => {
    const plain = drillListParams(drill.wonDeals(), AUGUST, { lossReasonKey: 'дорого' }, dictionaries.lossReasonCodes)
    expect(plain.filter).toMatchObject({ '!LEAD_ID': null, 'STAGE_ID': ['LOSE', 'C2:LOSE'], 'STAGE_SEMANTIC_ID': 'S' })
    expect(plain.byLeadIds).toBe(false)
    const byLead = drillListParams(drill.wonDeals(), AUGUST, { assignedById: 562 }, {})
    expect(byLead.filter).not.toHaveProperty('!LEAD_ID')
    expect(byLead.byLeadIds).toBe(true)
  })

  // ⚠ Фильтр и число пишут в одно поле: спред условия числа поверх фильтра молча заменил бы
  // условие, и под нулём «Не обработано» открывались бы все NEW за период.
  it('условие числа спорит с фильтром по одному полю — список пуст без запроса; совпадение — не спор', () => {
    expect(drillListParams(drill.unprocessed(), AUGUST, { junkReasonId: 'JUNK' }, {}).empty).toBe(true)
    expect(drillListParams(drill.unprocessed(), AUGUST, { leadStatusId: 'NEW' }, {}).empty).toBe(false)
    expect(drillListParams(drill.junkReason('SPAM', 'Спам', []), AUGUST, { junkReasonId: 'DUP' }, {}).empty).toBe(true)
    expect(drillListParams(drill.junkReason('DUP', 'Дубль', []), AUGUST, { junkReasonId: 'DUP' }, {}).empty).toBe(false)
    expect(drillListParams(drill.bySource('EMAIL', 'leads', 'Почта')!, AUGUST, { sourceId: 'CALL' }, {}).empty).toBe(true)
    expect(drillListParams(drill.bySource('CALL', 'won', 'Звонок')!, AUGUST, { sourceId: 'CALL' }, {}).empty).toBe(false)
    const codes = { 'дорого': ['LOSE'], 'не отвечает': ['APOLOGY'] }
    expect(drillListParams(drill.lossReason('не отвечает', 'x', codes), AUGUST, { lossReasonKey: 'дорого' }, codes).empty).toBe(true)
    expect(drillListParams(drill.lossReason('дорого', 'x', codes), AUGUST, { lossReasonKey: 'дорого' }, codes).empty).toBe(false)
    // «Обработано» под фильтром по стадии — другое поле (`!STATUS_ID`), оба условия складываются.
    expect(drillListParams(drill.processed(), AUGUST, { junkReasonId: 'JUNK' }, {})).toMatchObject({ empty: false, filter: { 'STATUS_ID': 'JUNK', '!STATUS_ID': 'NEW' } })
  })

  it('блок 7: по дате закрытия, без лида, только успешные, фильтры отчёта не действуют', () => {
    const params = drillListParams(drill.unlinkedSource('CALL', 'Звонок')!, AUGUST, { assignedById: 562, sourceId: 'EMAIL' }, {})
    expect(params.filter).toEqual({ '>=CLOSEDATE': '2026-08-01', '<CLOSEDATE': '2026-09-01', 'LEAD_ID': '', 'STAGE_SEMANTIC_ID': 'S', 'SOURCE_ID': 'CALL' })
    expect(params.byLeadIds).toBe(false)
  })
})

describe('строки списка', () => {
  it('лид портала: подписи из справочников, путь карточки, без названия — «Лид #id»', () => {
    const row = leadDrillRow({ ID: '7', TITLE: '', DATE_CREATE: '2026-08-10T10:00:00+03:00', STATUS_ID: 'JUNK_DUPLICATE', SOURCE_ID: 'CALL', ASSIGNED_BY_ID: '2' }, { ...dictionaries, users: { 2: 'Петров Сергей' } })
    expect(row).toMatchObject({ id: 7, title: 'Лид #7', source: 'Входящий звонок', manager: 'Петров Сергей', path: '/crm/lead/details/7/' })
    expect(row.stage).toBeTruthy()
    expect(crmPath('deal', 5)).toBe('/crm/deal/details/5/')
  })

  it('сделка портала: сумма в валюте сделки, стадия провала — названием причины, без лида — дата закрытия', () => {
    const row = dealDrillRow({ ID: 9, TITLE: 'Сделка', DATE_CREATE: '2026-08-01', CLOSEDATE: '2026-08-20', STAGE_ID: 'C2:LOSE', OPPORTUNITY: '150.5', CURRENCY_ID: 'USD', ASSIGNED_BY_ID: '' }, dictionaries, { 'C2:LOSE': 'LOSS_PRICE' })
    expect(row).toMatchObject({ id: 9, amount: 150.5, currencyId: 'USD', when: '2026-08-01', path: '/crm/deal/details/9/' })
    expect(row.manager).toBeUndefined()
    expect(row.stage).toBe(dictionaries.lossReasons.LOSS_PRICE)
    expect(dealDrillRow({ ID: 9, CLOSEDATE: '2026-08-20', STAGE_ID: 'WON' }, dictionaries, {}, 'unlinked')).toMatchObject({ when: '2026-08-20', stage: 'WON', title: 'Сделка #9' })
  })
})

describe('demoDrillRows', () => {
  const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads', firstResponseSlaMinutes: 120 })

  it('списки демо-набора сходятся с числами на экране', () => {
    expect(demoDrillRows(drill.leads(), dataset, {})).toHaveLength(report.summary.totalLeads)
    expect(demoDrillRows(drill.junk(), dataset, {})).toHaveLength(report.summary.junk)
    expect(demoDrillRows(drill.qualified(), dataset, {})).toHaveLength(report.summary.qualified)
    expect(demoDrillRows(drill.wonDeals(), dataset, {})).toHaveLength(report.summary.wonDeals)
    expect(demoDrillRows(drill.lostDeals(), dataset, {})).toHaveLength(report.lostDeals.count)
    expect(demoDrillRows(drill.unprocessed(), dataset, {})).toHaveLength(report.processing!.unprocessed)
    expect(demoDrillRows(drill.processed(), dataset, {})).toHaveLength(report.processing!.processed)
    const [reason] = report.junkByReason
    expect(demoDrillRows(drill.junkReason(reason!.reasonId, 'x', []), dataset, {})).toHaveLength(reason!.count)
    const [loss] = report.lostDeals.byReason
    expect(demoDrillRows(drill.lossReason(loss!.reasonId, 'x', { [loss!.reasonId]: [loss!.reasonId] }), dataset, {})).toHaveLength(loss!.count)
    const [source] = report.bySource
    expect(demoDrillRows(drill.bySource(source!.sourceId, 'won', 'x')!, dataset, {})).toHaveLength(source!.won)
  })

  it('под фильтрами отчёта — те же правила; блок 7 в демо пуст; карточек нет', () => {
    const [sourceId] = Object.keys(dataset.dictionaries.sources)
    const filtered = buildReport(...Object.values({ leads: dataset.leads.filter(l => l.sourceId === sourceId), deals: dataset.deals.filter(d => d.sourceId === sourceId) }) as [typeof dataset.leads, typeof dataset.deals], { conversionBase: 'quality-leads' })
    expect(demoDrillRows(drill.leads(), dataset, { sourceId })).toHaveLength(filtered.summary.totalLeads)
    expect(demoDrillRows(drill.unlinked(), dataset, {})).toEqual([])
    const row = demoDrillRows(drill.leads(), dataset, {})[0]!
    expect(row.path).toBe('')
    expect(row.title).toMatch(/^Лид #/)
    expect(row.manager).toBeTruthy()
  })
})

describe('plainDealListParams: готовый фильтр отчёта «Сделки по менеджерам»', () => {
  const request = {
    entity: 'deal' as const,
    dealScope: 'plain' as const,
    title: 'Сделки: Минск · Иванов Иван · Новая',
    extra: { CATEGORY_ID: 0, STAGE_SEMANTIC_ID: 'P', MYCOMPANY_ID: 10, ASSIGNED_BY_ID: 1, STAGE_ID: 'NEW' }
  }

  // Фильтр приходит целиком: ни периода отчёта по лидам, ни его фильтров тут быть не должно —
  // у второго отчёта свой отбор, и подмешать чужой значило бы показать не тот список.
  it('фильтр списка — ровно условие числа, ничего сверх него', () => {
    const params = plainDealListParams(request)
    expect(params.method).toBe('crm.deal.list')
    expect(params.filter).toEqual(request.extra)
    expect(params.byLeadIds).toBe(false)
    expect(params.empty).toBe(false)
    expect(params.select).toContain('STAGE_ID')
  })

  it('через общий разбор запроса получается то же самое', () => {
    const viaDispatch = drillListParams(request, { from: '2026-08-01', to: '2026-08-31' }, { sourceId: 'CALL' }, {})
    expect(viaDispatch).toEqual(plainDealListParams(request))
  })
})
