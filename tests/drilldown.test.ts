import { describe, expect, it } from 'vitest'
import type { ReportDictionaries } from '~/types/report'
import { activityDrillRow, callDrillRow, crmPath, dealDrillRow, drill, drillListParams, leadDrillRow, ownerSection, plainDealListParams } from '~/utils/drilldown'
import { DEFAULT_ID_CHUNK } from '~/utils/filters'
import { UNSPECIFIED_REASON, UNSPECIFIED_SOURCE } from '~/utils/metrics'
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
    expect(drill.bySource('CALL', 'leads', 'Звонок')).toMatchObject({ entity: 'lead', extra: { SOURCE_ID: 'CALL' } })
  })

  /**
   * ⛔ Успешные сделки источника — ПЕРЕЧИСЛЕНИЕМ записей, а не условием `SOURCE_ID`.
   *
   * Разрез считает продажу по источнику ЛИДА, а условия «источник моего лида» у `crm.deal.list`
   * нет. Спроси мы собственный `SOURCE_ID` сделки — под числом открылся бы ДРУГОЙ список: на
   * боевом портале у 54 сделок из 261 он расходится с лидом, а у «Заказа покупателя» из 1С его
   * нет вовсе. Поэтому список — те же самые сделки, что посчитаны (`SourceRow.wonDealIds`).
   */
  it('успешные сделки источника открываются перечислением ровно тех сделок, что посчитаны', () => {
    expect(drill.wonBySource('CALL', 'Звонок', [10, 11])).toMatchObject({
      entity: 'deal',
      dealScope: 'from-leads',
      title: 'Успешные сделки из лидов: Звонок',
      extra: { ID: [10, 11] }
    })
    // Собственного источника сделки в условии нет и быть не должно.
    expect(drill.wonBySource('CALL', 'Звонок', [10])!.extra).not.toHaveProperty('SOURCE_ID')
    expect(drill.wonBySource(UNSPECIFIED_SOURCE, 'Не указан', [10])).toBeUndefined()
  })

  /**
   * ⚠ Ноль успешных — число некликабельно: пустой `ID: []` портал НЕ ВИДИТ, и под заголовком
   * одного источника открылся бы весь период. Список длиннее ОДНОГО запроса (`DEFAULT_ID_CHUNK`,
   * 500 — проверено на боевом портале) — тоже: резать его на куски слайдер не умеет, а молча
   * обрезанный список короче числа над ним.
   */
  it('успешные сделки источника: ноль и перебор потолка делают число некликабельным', () => {
    expect(drill.wonBySource('CALL', 'Звонок', [])).toBeUndefined()
    const tooMany = Array.from({ length: DEFAULT_ID_CHUNK + 1 }, (_, i) => i + 1)
    expect(drill.wonBySource('CALL', 'Звонок', tooMany)).toBeUndefined()
    expect(drill.wonBySource('CALL', 'Звонок', tooMany.slice(0, DEFAULT_ID_CHUNK))).toBeDefined()
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

  /**
   * ⛔ Условие, называющее записи ПОИМЁННО, списка ID лидов не требует — даже под фильтром.
   *
   * Разница не косметическая: `byLeadIds` решает не только «как читать», но и «чем показывать».
   * С ним список читается кусками, а такое условие в параметры слайдера портала не помещается —
   * и под фильтром «Источник» детализация открывалась бы запасной панелью вместо настоящего
   * слайдера (решение владельца 2026-09-06). Пересечение при этом ничего не меняет: эти сделки
   * и так отобраны из набора, посчитанного под тем же фильтром.
   */
  it('перечисление сделок не требует списка ID лидов даже под фильтром по полю лида', () => {
    const params = drillListParams(drill.wonBySource('CALL', 'Звонок', [10, 11])!, AUGUST, { sourceId: 'CALL' }, {})
    expect(params.byLeadIds).toBe(false)
    expect(params.filter).toMatchObject({ ID: [10, 11] })
    // Под фильтром по менеджеру — то же самое: условие самодостаточно.
    expect(drillListParams(drill.wonBySource('CALL', 'Звонок', [10])!, AUGUST, { assignedById: 562 }, {}).byLeadIds).toBe(false)
  })

  /**
   * ⛔ Фильтр отчёта «Источник» — тоже по списку ID лидов, как менеджер и стадия.
   *
   * Спросить у сделки её `SOURCE_ID` технически можно — поле есть, — и отчёт так и делал. Но
   * разрез по источникам считает продажу по источнику ЛИДА: под фильтром «Звонок» открывалось бы
   * не то множество, что стоит в строке «Звонок» той же таблицы.
   */
  it('фильтр по источнику отбирает сделки по лидам, а не собственным полем сделки', () => {
    const params = drillListParams(drill.wonDeals(), AUGUST, { sourceId: 'CALL' }, {})
    expect(params.byLeadIds).toBe(true)
    expect(params.filter).not.toHaveProperty('SOURCE_ID')
    expect(params.filter).not.toHaveProperty('!LEAD_ID')
  })

  // ⚠ Фильтр и число пишут в одно поле: спред условия числа поверх фильтра молча заменил бы
  // условие, и под нулём «Не обработано» открывались бы все NEW за период.
  it('условие числа спорит с фильтром по одному полю — список пуст без запроса; совпадение — не спор', () => {
    expect(drillListParams(drill.unprocessed(), AUGUST, { junkReasonId: 'JUNK' }, {}).empty).toBe(true)
    expect(drillListParams(drill.unprocessed(), AUGUST, { leadStatusId: 'NEW' }, {}).empty).toBe(false)
    expect(drillListParams(drill.junkReason('SPAM', 'Спам', []), AUGUST, { junkReasonId: 'DUP' }, {}).empty).toBe(true)
    expect(drillListParams(drill.junkReason('DUP', 'Дубль', []), AUGUST, { junkReasonId: 'DUP' }, {}).empty).toBe(false)
    expect(drillListParams(drill.bySource('EMAIL', 'leads', 'Почта')!, AUGUST, { sourceId: 'CALL' }, {}).empty).toBe(true)
    // ⚠ У сделок спора по источнику быть НЕ МОЖЕТ: фильтр отчёта отбирает их списком ID лидов,
    // а условие числа — перечислением сделок. Разные поля, оба применяются.
    expect(drillListParams(drill.wonBySource('CALL', 'Звонок', [10])!, AUGUST, { sourceId: 'CALL' }, {}).empty).toBe(false)
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

describe('строки дел CRM и звонков', () => {
  const dictionaries: ReportDictionaries = {
    sources: {}, junkReasons: {}, lossReasons: {},
    users: { 16: 'Петров Пётр' }
  }

  it('дело подписано видом и направлением, а открывается карточкой своей записи', () => {
    const row = activityDrillRow({
      ID: '4440660',
      SUBJECT: 'Счет № 00КА-058665',
      CREATED: '2026-08-03T08:40:08+03:00',
      TYPE_ID: '4',
      DIRECTION: '2',
      RESPONSIBLE_ID: '16',
      OWNER_ID: '270825',
      OWNER_TYPE_ID: '1'
    }, dictionaries)
    expect(row.title).toBe('Счет № 00КА-058665')
    expect(row.stage).toBe('Письмо, исходящее')
    expect(row.manager).toBe('Петров Пётр')
    // Карточки самого дела в портале нет — открывается лид, к которому оно привязано.
    expect(row.path).toBe('/crm/lead/details/270825/')
  })

  /** ⚠ У встреч и задач портал ставит `DIRECTION: 0` — «направление: —» было бы шумом. */
  it('у встречи направление не печатается', () => {
    expect(activityDrillRow({ ID: '1', TYPE_ID: '1', DIRECTION: '0' }, dictionaries).stage).toBe('Встреча')
  })

  /**
   * ⚠ Просроченное дело показывает СРОК, а не дату создания: число посчитано по сроку и без нижней
   * границы периода. Иначе под ним встали бы даты трёхлетней давности.
   */
  it('просроченное дело показывает срок, а не дату создания', () => {
    const raw = { ID: '1', TYPE_ID: '3', CREATED: '2023-01-10T10:00:00+03:00', END_TIME: '2026-08-20T10:00:00+03:00' }
    expect(activityDrillRow(raw, dictionaries, 'created').when).toBe('2023-01-10T10:00:00+03:00')
    expect(activityDrillRow(raw, dictionaries, 'overdue').when).toBe('2026-08-20T10:00:00+03:00')
  })

  /**
   * ⛔ Неизвестный тип владельца — строка БЕЗ ссылки. Догадка увела бы человека в чужую карточку:
   * типов у портала больше четырёх (счета, смарт-процессы), и `/crm/lead/` для смарт-процесса
   * открыл бы существующий и совершенно посторонний лид с тем же номером.
   */
  it('дело неизвестного владельца остаётся без ссылки', () => {
    expect(activityDrillRow({ ID: '1', TYPE_ID: '4', OWNER_ID: '5', OWNER_TYPE_ID: '31' }, dictionaries).path).toBeUndefined()
    expect(activityDrillRow({ ID: '1', TYPE_ID: '4', OWNER_TYPE_ID: '1' }, dictionaries).path).toBeUndefined()
    expect(ownerSection('2')).toBe('deal')
    expect(ownerSection('99')).toBeUndefined()
  })

  /** ⛔ У звонка `CALL_TYPE: 1` — ИСХОДЯЩИЙ: обратно шкале дел CRM. */
  it('звонок подписан номером, направлением и длительностью', () => {
    const row = callDrillRow({
      ID: '1517503',
      PORTAL_USER_ID: '16',
      PHONE_NUMBER: '+375297006553',
      CALL_TYPE: '1',
      CALL_DURATION: '120',
      CALL_FAILED_CODE: '200',
      CALL_START_DATE: '2026-08-02T10:39:46+03:00'
    }, dictionaries)
    expect(row.title).toBe('+375297006553')
    expect(row.stage).toBe('Исходящий')
    expect(row.amount).toBe(120)
    expect(row.manager).toBe('Петров Пётр')
    // Карточки у звонка нет — ссылки быть не должно.
    expect(row.path).toBeUndefined()
  })

  it('входящий и недозвон подписаны как есть', () => {
    expect(callDrillRow({ ID: '1', CALL_TYPE: '2', CALL_FAILED_CODE: '200' }, dictionaries).stage).toBe('Входящий')
    expect(callDrillRow({ ID: '1', CALL_TYPE: '1', CALL_FAILED_CODE: '304' }, dictionaries).stage)
      .toBe('Исходящий, не дозвонились')
  })

  /** Скрытый номер портал отдаёт пустым — пустая строка в списке неотличима от отступа. */
  it('звонок без номера подписан своим идентификатором', () => {
    expect(callDrillRow({ ID: '77', PHONE_NUMBER: '' }, dictionaries).title).toBe('Звонок #77')
  })
})

describe('охват лида в списке', () => {
  const dict: ReportDictionaries = { sources: {}, junkReasons: {}, lossReasons: {} }
  const raw = {
    ID: '5',
    TITLE: 'Лид мая',
    DATE_CREATE: '2026-05-04T10:00:00+03:00',
    DATE_CLOSED: '2026-08-20T10:00:00+03:00'
  }

  /**
   * ⛔ Числа «Успешно/Провалено» отчёта 3 посчитаны по дате ЗАКРЫТИЯ. Покажи список дату создания
   * — под августовским числом встали бы майские даты, и сверить список с числом было бы нечем.
   * Тот же приём, что `dealScope: 'unlinked'` у сделок.
   */
  it('закрытый лид показывает дату закрытия, а созданный — создания', () => {
    expect(leadDrillRow(raw, dict, 'created').when).toBe('2026-05-04T10:00:00+03:00')
    expect(leadDrillRow(raw, dict, 'closed').when).toBe('2026-08-20T10:00:00+03:00')
  })

  /** ⚠ Умолчание — создание: так список лидов отчёта 1 остаётся прежним. */
  it('без охвата берётся дата создания', () => {
    expect(leadDrillRow(raw, dict).when).toBe('2026-05-04T10:00:00+03:00')
  })

  /** ⚠ Дата закрытия может не прийти — тогда лучше дата создания, чем пустая ячейка. */
  it('без даты закрытия строка не остаётся без даты вовсе', () => {
    expect(leadDrillRow({ ID: '5', DATE_CREATE: '2026-05-04T10:00:00+03:00' }, dict, 'closed').when)
      .toBe('2026-05-04T10:00:00+03:00')
  })
})
