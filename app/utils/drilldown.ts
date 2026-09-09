import type { ReportDictionaries, ReportFilters, ReportPeriod } from '~/types/report'
import type { DrillFilterValue } from '~/utils/drillSlider'
import { periodFilter, unlinkedWonDealsParams } from '~/utils/b24Query'
import { DEFAULT_ID_CHUNK, dealRestFilter, leadRestFilter, needsLeadIds, stageCodesFor } from '~/utils/filters'
import { INITIAL_LEAD_STATUS } from '~/utils/leadHistory'
import { leadStageLabel, lossReasonLabel, sourceLabel } from '~/utils/labels'
import { UNSPECIFIED_REASON, UNSPECIFIED_SOURCE } from '~/utils/metrics'

/**
 * Детализация по клику: за числом отчёта — список записей портала «тем же фильтром, что дал
 * число» (решение владельца от 2026-09-04, п. 10). Здесь — ЧТО это за список: сущность, условие
 * поверх периода и фильтров отчёта, заголовок; и как строка портала или демо-набора становится
 * строкой списка. Чистые функции: ни сети, ни SDK. Сами запросы страницами — в `useDrilldown`.
 *
 * ⚠ Число, за которым нельзя собрать список тем же условием, некликабельно, а не «примерно
 * такое же»: «источник не указан» — остаток арифметики, «просрочено» — из истории стадий.
 * Список, не сходящийся с числом над ним, хуже отсутствия списка.
 */

/**
 * Что показывает список за числом.
 *
 * ⚠ `activity` и `call` добавлены отчётом «Активность пользователей». Общего у них с лидами и
 * сделками ровно одно — устройство слайдера; методы, поля и даже РЕГИСТР ключа фильтра у них
 * свои (`voximplant.statistic.get` понимает только заглавный `FILTER`), поэтому ветвление живёт
 * в `useDrillPage`, а не размазано по вызывающим.
 */
export type DrillEntity = 'lead' | 'deal' | 'activity' | 'call'

export interface DrillRequest {
  entity: DrillEntity
  /** Как подписано число, по которому нажали, — заголовок слайдера. */
  title: string
  /**
   * Условие поверх периода и фильтров отчёта: стадия, семантика, источник, перечисление записей.
   * У `dealScope: 'plain'` это ПОЛНЫЙ фильтр списка — там отчёт строит его сам, целиком
   * (матрица менеджеров).
   *
   * ⚠ Числа в перечислении разрешены не для симметрии: идентификаторы записей портала приходят
   * числами (`ID in (...)` у списка успешных сделок источника), и приведение их к строкам было бы
   * лишним местом, где значение может потеряться.
   */
  extra: Record<string, string | number | Array<string | number>>
  /**
   * Сделки: из лидов (как в воронке — период по дате создания, фильтры отчёта действуют),
   * без лида (блок 7: по дате закрытия, `LEAD_ID` пуст, только успешные, фильтры не действуют)
   * или `plain` — фильтр целиком в `extra`, ни периода отчёта по лидам, ни его фильтров
   * (отчёт «Сделки по менеджерам»: там свой отбор — направление, охват, компания, менеджер, стадия).
   */
  dealScope?: 'from-leads' | 'unlinked' | 'plain'
  /** Число, по которому нажали, — чтобы слайдер говорил «показано M из N», не долистывая до конца. */
  total?: number
  /**
   * Источник ВСЕХ записей списка — названием. Есть только у списка, отобранного по источнику
   * ЛИДА (`wonBySource`): там колонка «Источник» иначе печатала бы собственное поле сделки,
   * которого у «Заказа покупателя» из 1С нет вовсе.
   */
  sourceName?: string
}

/** Строка списка — уже с подписями из справочников; `path` — путь карточки в CRM портала. */
export interface DrillRow {
  id: number
  title: string
  /** Дата создания (лид, сделка из лида) или закрытия (сделка без лида), ISO с датой в начале. */
  when?: string
  stage?: string
  source?: string
  manager?: string
  amount?: number
  currencyId?: string
  /**
   * Путь карточки в портале. ПУСТОЙ означает «открывать нечего», и это штатный случай.
   *
   * ⚠ У дела CRM запись-владелец может быть смарт-процессом, у звонка её может не быть вовсе
   * (звонок на общую линию, который не подняли). Подставить сюда догадку значило бы увести
   * человека в чужую карточку с тем же номером — существующую и совершенно постороннюю.
   */
  path?: string
}

/** Поля строк для списка. `TITLE` — то, по чему человек узнаёт запись; остальное — подписи. */
export const DRILL_LEAD_SELECT = ['ID', 'TITLE', 'DATE_CREATE', 'DATE_CLOSED', 'STATUS_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID'] as const
export const DRILL_DEAL_SELECT = ['ID', 'TITLE', 'DATE_CREATE', 'CLOSEDATE', 'STAGE_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'CURRENCY_ID'] as const

/** Строка `crm.lead.list` для списка. */
export interface B24DrillLeadRow {
  ID: string | number
  TITLE?: string | null
  DATE_CREATE?: string | null
  /** Дата закрытия лида. ⚠ Это НЕ `CLOSEDATE` сделки: у портала имена полей разные. */
  DATE_CLOSED?: string | null
  STATUS_ID?: string | null
  SOURCE_ID?: string | null
  ASSIGNED_BY_ID?: string | number | null
}

/** Строка `crm.deal.list` для списка. */
export interface B24DrillDealRow {
  ID: string | number
  TITLE?: string | null
  DATE_CREATE?: string | null
  CLOSEDATE?: string | null
  STAGE_ID?: string | null
  SOURCE_ID?: string | null
  ASSIGNED_BY_ID?: string | number | null
  OPPORTUNITY?: string | number | null
  CURRENCY_ID?: string | null
}

export const DRILL_ACTIVITY_SELECT = ['ID', 'SUBJECT', 'CREATED', 'END_TIME', 'TYPE_ID', 'DIRECTION', 'COMPLETED', 'RESPONSIBLE_ID', 'OWNER_ID', 'OWNER_TYPE_ID'] as const
/** Строка `crm.activity.list` для списка. */
export interface B24DrillActivityRow {
  ID: string | number
  SUBJECT?: string | null
  CREATED?: string | null
  END_TIME?: string | null
  TYPE_ID?: string | number | null
  DIRECTION?: string | number | null
  COMPLETED?: string | null
  RESPONSIBLE_ID?: string | number | null
  /** Запись CRM, к которой привязано дело, — по ней и открывается карточка. */
  OWNER_ID?: string | number | null
  /** `1` — лид, `2` — сделка, `3` — контакт, `4` — компания. */
  OWNER_TYPE_ID?: string | number | null
}

/**
 * Строка `voximplant.statistic.get` для списка.
 *
 * ⚠ Списка полей (`select`) у метода НЕТ — он всегда отдаёт запись целиком, и просить у него
 * меньше нечем. Поэтому здесь перечислено то, что список ЧИТАЕТ, а не то, что он запрашивает.
 */
export interface B24DrillCallRow {
  ID: string | number
  PORTAL_USER_ID?: string | number | null
  PHONE_NUMBER?: string | null
  CALL_TYPE?: string | number | null
  CALL_DURATION?: string | number | null
  CALL_FAILED_CODE?: string | number | null
  CALL_START_DATE?: string | null
}

const lead = (title: string, extra: DrillRequest['extra'] = {}): DrillRequest => ({ entity: 'lead', title, extra })
const dealFromLeads = (title: string, extra: DrillRequest['extra'] = {}): DrillRequest => ({ entity: 'deal', title, extra, dealScope: 'from-leads' })
const unlinkedDeal = (title: string, extra: DrillRequest['extra'] = {}): DrillRequest => ({ entity: 'deal', title, extra, dealScope: 'unlinked' })

/**
 * Что стоит за каждым кликабельным числом. `undefined` — число некликабельно (см. шапку файла).
 * Названия — как подписи чисел на экране, чтобы заголовок слайдера повторял то, по чему нажали.
 */
export const drill = {
  leads: () => lead('Лиды'),
  junk: () => lead('Брак лидов', { STATUS_SEMANTIC_ID: 'F' }),
  qualified: () => lead('Квалифицировано в сделку', { STATUS_SEMANTIC_ID: 'S' }),
  unprocessed: () => lead('Не обработано', { STATUS_ID: INITIAL_LEAD_STATUS }),
  processed: () => lead('Обработано', { '!STATUS_ID': INITIAL_LEAD_STATUS }),
  openStage: (stageId: string, label: string) => lead(`Открытые лиды: ${label}`, { STATUS_ID: stageId }),
  /**
   * Причина брака. «Причина не указана» — брак на стадии вне справочника: семантика «провал» и
   * НЕ известные стадии; без известных стадий условие — просто «провал».
   */
  junkReason: (reasonId: string, label: string, knownJunkIds: readonly string[]): DrillRequest =>
    reasonId === UNSPECIFIED_REASON
      ? lead(`Брак лидов: ${label}`, knownJunkIds.length ? { 'STATUS_SEMANTIC_ID': 'F', '!STATUS_ID': [...knownJunkIds] } : { STATUS_SEMANTIC_ID: 'F' })
      : lead(`Брак лидов: ${label}`, { STATUS_ID: reasonId }),
  /**
   * Разрез по источнику: лиды, брак, квалифицировано. Источник у лида — его собственное поле,
   * условие спрашивается прямо.
   *
   * ⚠ Успешных сделок здесь НЕТ, и это не забывчивость: у них другой источник данных и другая
   * механика списка — см. `wonBySource`. Одна функция на оба случая уже стоила дефекта: список
   * успешных приходит четвёртым аргументом, забыть его было нечем, и «Топ-5 источников» молча
   * потерял кликабельность колонки при полностью зелёной сборке.
   */
  bySource: (sourceId: string, part: 'leads' | 'junk' | 'qualified', label: string): DrillRequest | undefined => {
    if (sourceId === UNSPECIFIED_SOURCE) return undefined
    switch (part) {
      case 'leads': return lead(`Лиды: ${label}`, { SOURCE_ID: sourceId })
      case 'junk': return lead(`Брак лидов: ${label}`, { SOURCE_ID: sourceId, STATUS_SEMANTIC_ID: 'F' })
      case 'qualified': return lead(`Квалифицировано: ${label}`, { SOURCE_ID: sourceId, STATUS_SEMANTIC_ID: 'S' })
    }
  },
  /**
   * Успешные сделки источника — ПЕРЕЧИСЛЕНИЕМ тех самых записей, что вошли в число.
   *
   * ⛔ Условия «источник моего лида» у `crm.deal.list` нет, а собственный `SOURCE_ID` сделки
   * спрашивать нельзя: разрез размечает продажу источником ЛИДА (`sourceRows`), у сделки он
   * бывает пуст или свой — 54 расхождения из 261 на боевом портале (замер 2026-09-09). Поэтому
   * список — не «то же условие», а буквально те же сделки: `wonDealIds` считается тем же
   * проходом, что и `won` с выручкой, и разойтись им негде.
   *
   * ⚠ Ноль успешных — число некликабельно: пустой `ID: []` портал НЕ ВИДИТ, и под заголовком
   * одного источника открылся бы весь период.
   *
   * ⚠ Перечисление длиннее одного запроса (`DEFAULT_ID_CHUNK`) — тоже: резать список на куски
   * слайдер не умеет, а молча обрезанный список короче числа над ним. На боевом портале это
   * ~160 успешных сделок из лидов в месяц на все источники разом, то есть упереться в потолок
   * можно только очень длинным периодом.
   */
  wonBySource: (sourceId: string, label: string, wonDealIds: readonly number[]): DrillRequest | undefined =>
    sourceId !== UNSPECIFIED_SOURCE && wonDealIds.length && wonDealIds.length <= DEFAULT_ID_CHUNK
      ? { ...dealFromLeads(`Успешные сделки из лидов: ${label}`, { ID: [...wonDealIds] }), sourceName: label }
      : undefined,

  /**
   * Почему число «успешных» источника НЕ кликабельно — словами, для подсказки у самого числа.
   *
   * ⚠ Молча негорящее число читается как поломка отчёта: остальные в той же строке открываются, а
   * это нет. Причина при этом объяснимая и зависит от ВЫБОРА человека — периода, — так что сказать
   * её стоит. `undefined` значит «кликабельно» либо «объяснять нечего»: ноль сделок — это ноль
   * записей, за ним не должно открываться ничего, и подпись тут была бы шумом.
   */
  wonBySourceHint: (sourceId: string, wonDealIds: readonly number[]): string | undefined =>
    sourceId !== UNSPECIFIED_SOURCE && wonDealIds.length > DEFAULT_ID_CHUNK
      ? `Список не открыть: ${wonDealIds.length} сделок — портал столько за раз не отдаёт. Выберите период короче.`
      : undefined,
  wonDeals: () => dealFromLeads('Успешные сделки из лидов', { STAGE_SEMANTIC_ID: 'S' }),
  lostDeals: () => dealFromLeads('Проигранные сделки', { STAGE_SEMANTIC_ID: 'F' }),
  /**
   * Причина проигрыша — все коды стадий провала под одним названием (`reasonMerge`). «Причина
   * не указана» — провал на стадии вне известных кодов; ключ без кодов — см. `stageCodesFor`.
   */
  lossReason: (reasonKey: string, label: string, codesByKey: Record<string, string[]>): DrillRequest => {
    if (reasonKey === UNSPECIFIED_REASON) {
      const known = Object.values(codesByKey).flat()
      return dealFromLeads(`Проигранные сделки: ${label}`, known.length ? { 'STAGE_SEMANTIC_ID': 'F', '!STAGE_ID': known } : { STAGE_SEMANTIC_ID: 'F' })
    }
    return dealFromLeads(`Проигранные сделки: ${label}`, { STAGE_ID: stageCodesFor(reasonKey, codesByKey) })
  },
  unlinked: () => unlinkedDeal('Успешные сделки без связи с лидом'),
  unlinkedSource: (sourceId: string, label: string): DrillRequest | undefined =>
    sourceId === UNSPECIFIED_SOURCE ? undefined : unlinkedDeal(`Успешные сделки без лида: ${label}`, { SOURCE_ID: sourceId })
} as const

/** Параметры одной страницы списка — без курсора: его добавляет тот, кто листает. */
export interface DrillListParams {
  method: 'crm.lead.list' | 'crm.deal.list'
  select: string[]
  /**
   * Условие списка.
   *
   * ⚠ Типизировано значениями фильтра СЛАЙДЕРА (`DrillFilterValue`), а не `unknown`: отсюда
   * условие уезжает в параметры вызова портала, и там его встречает проверяющий разбор. Положи
   * сюда билдер фильтра булево или вложенный объект — при `unknown` компилятор промолчал бы, а
   * список просто не открылся бы на боевом портале без единого объяснения почему.
   */
  filter: Record<string, DrillFilterValue>
  /**
   * Сделки под фильтром по полям ЛИДА — только по списку ID лидов (`LEAD_ID in`), как и в самом
   * отчёте; список у композабла, здесь только признак.
   *
   * ⚠ Полей лида три: менеджер, стадия и ИСТОЧНИК. Источник попал сюда не сразу — `SOURCE_ID` у
   * сделки есть, и спросить его прямо технически можно; но разрез размечает продажу источником
   * лида, и прямой вопрос дал бы под фильтром не то множество, что посчитано в строке.
   *
   * ⚠ От этого признака зависит не только КАК читать, но и ЧЕМ показывать: условие «кусками по
   * списку ID» в параметры слайдера портала не помещается, поэтому такой список открывает
   * запасная панель внутри отчёта (`useDrilldown`, случай 1).
   */
  byLeadIds: boolean
  /**
   * Список пуст по построению, портал не спрашивают: условие числа спорит с фильтром отчёта по
   * одному полю (фильтр «стадия = брак», клик по «Не обработано» = `NEW`). Число под таким
   * фильтром — ноль (`leadCountBatch` такие счётчики не шлёт), и список обязан быть пустым, а
   * не «все NEW за период»: спред условия числа поверх фильтра молча заменил бы условие.
   */
  empty: boolean
}

/**
 * Список сделок по ГОТОВОМУ фильтру (`dealScope: 'plain'`): его целиком строит отчёт «Сделки по
 * менеджерам» — направление, охват, компания, менеджер, стадия. Ни периода отчёта по лидам, ни его
 * фильтров здесь нет и быть не должно.
 */
export function plainDealListParams(request: DrillRequest): DrillListParams {
  return { method: 'crm.deal.list', select: [...DRILL_DEAL_SELECT], filter: { ...request.extra }, byLeadIds: false, empty: false }
}

/** Условие числа и фильтр отчёта пишут в одно поле разные значения — такого множества нет. */
function conflicts(base: Record<string, unknown>, extra: DrillRequest['extra']): boolean {
  return Object.entries(extra).some(([key, value]) => key in base && JSON.stringify(base[key]) !== JSON.stringify(value))
}

/**
 * Что спросить у портала. Порядок условий: период → фильтры отчёта → условие числа. Одно поле у
 * фильтра и у числа — либо то же значение (клик по строке своего источника под фильтром по нему),
 * либо спор — и тогда список пуст без запроса (`empty`), см. `conflicts`.
 */
export function drillListParams(request: DrillRequest, period: ReportPeriod, filters: ReportFilters, codesByReason: Record<string, string[]>): DrillListParams {
  if (request.entity === 'lead') {
    const base = { ...periodFilter(period), ...leadRestFilter(filters) }
    return { method: 'crm.lead.list', select: [...DRILL_LEAD_SELECT], filter: { ...base, ...request.extra }, byLeadIds: false, empty: conflicts(base, request.extra) }
  }
  // Полный фильтр пришёл готовым: период и фильтры отчёта по лидам к нему не применяются —
  // у отчёта «Сделки по менеджерам» свой отбор, и смешать их значило бы показать не тот список.
  if (request.dealScope === 'plain') return plainDealListParams(request)
  if (request.dealScope === 'unlinked') {
    return { method: 'crm.deal.list', select: [...DRILL_DEAL_SELECT], filter: { ...unlinkedWonDealsParams(period).filter, ...request.extra }, byLeadIds: false, empty: false }
  }
  // Условие числа уже НАЗЫВАЕТ записи поимённо (`wonBySource`) — список ID лидов ему не нужен:
  // эти сделки отобраны из набора, уже посчитанного под фильтром отчёта, и пересечение с ним
  // ничего не изменит. Разница не косметическая: с `byLeadIds` список читается кусками, а такое
  // условие в слайдер портала не помещается — и под фильтром «Источник» ВСЕ детализации сделок
  // открывались бы запасной панелью вместо настоящего слайдера (решение владельца 2026-09-06).
  const byLeadIds = needsLeadIds(filters) && !('ID' in request.extra)
  const base = { ...periodFilter(period), ...(byLeadIds ? {} : { '!LEAD_ID': null }), ...dealRestFilter(filters, codesByReason) }
  return {
    method: 'crm.deal.list',
    select: [...DRILL_DEAL_SELECT],
    filter: { ...base, ...request.extra },
    byLeadIds,
    empty: conflicts(base, request.extra)
  }
}

/**
 * Путь карточки в CRM портала — для `slider.openPath`; вне портала он никуда не ведёт.
 *
 * ⚠ Принимает ИМЯ РАЗДЕЛА CRM, а не сущность слайдера, и это разные множества: у слайдера есть
 * `activity` и `call`, а разделов `/crm/activity/` и `/crm/call/` в портале нет вовсе. Дело
 * открывается карточкой своей записи (лид, сделка, контакт, компания), звонок — карточкой той же
 * записи или ничем.
 */
export function crmPath(section: CrmSection, id: number): string {
  return `/crm/${section}/details/${id}/`
}

/** Разделы CRM, карточки которых умеет открывать список. */
export type CrmSection = 'lead' | 'deal' | 'contact' | 'company'

/**
 * `OWNER_TYPE_ID` дела → раздел CRM.
 *
 * ⚠ Неизвестный тип — `undefined`, то есть строка БЕЗ ссылки. Догадка здесь увела бы человека в
 * чужую карточку: типов у портала больше четырёх (счета, смарт-процессы), и `/crm/lead/` для
 * смарт-процесса открыл бы лид с тем же номером — существующий и совершенно посторонний.
 */
export function ownerSection(ownerTypeId: string | number | null | undefined): CrmSection | undefined {
  switch (Number(ownerTypeId)) {
    case 1: return 'lead'
    case 2: return 'deal'
    case 3: return 'contact'
    case 4: return 'company'
    default: return undefined
  }
}

function toId(value: string | number | null | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function toText(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function managerLabel(dictionaries: ReportDictionaries, id: number): string | undefined {
  if (!id) return undefined
  return dictionaries.users?.[String(id)] ?? `Сотрудник #${id}`
}

/**
 * По какой дате показывать строку лида: создания или ЗАКРЫТИЯ.
 *
 * ⚠ Ровно тот же приём, что `dealScope: 'unlinked'` у сделок: число, посчитанное по дате
 * закрытия, обязано открывать список с датами закрытия.
 */
export type LeadDrillScope = 'created' | 'closed'

/** Строка лида портала → строка списка. Без названия — «Лид #id»: пустая строка в списке неотличима от отступа. */
export function leadDrillRow(
  row: B24DrillLeadRow,
  dictionaries: ReportDictionaries,
  scope: LeadDrillScope = 'created'
): DrillRow {
  const id = toId(row.ID)
  const status = toText(row.STATUS_ID)
  const source = toText(row.SOURCE_ID)
  const manager = managerLabel(dictionaries, toId(row.ASSIGNED_BY_ID))
  // ⚠ Дата — по СМЫСЛУ числа, как у сделок (`dealScope`) и дел (`activityScope`). Числа
  // «успешно» и «провалено» в отчёте 3 посчитаны по дате ЗАКРЫТИЯ; покажи список дату создания —
  // под августовским числом встали бы майские даты, и сверить список с числом было бы нечем.
  //
  // ⚠ Закрытая дата может не прийти (лид ещё в работе, поле пусто) — тогда берём создание, а не
  // печатаем прочерк: дата в списке нужна, чтобы узнать запись, а не только чтобы сверить период.
  const when = scope === 'closed'
    ? (toText(row.DATE_CLOSED) || toText(row.DATE_CREATE))
    : toText(row.DATE_CREATE)
  return {
    id,
    title: toText(row.TITLE) || `Лид #${id}`,
    ...(when ? { when } : {}),
    ...(status ? { stage: leadStageLabel(dictionaries, status) } : {}),
    ...(source ? { source: sourceLabel(dictionaries, source) } : {}),
    ...(manager ? { manager } : {}),
    path: crmPath('lead', id)
  }
}

/**
 * Строка сделки портала → строка списка. Сумма — как в CRM, в валюте сделки: приводить к
 * базовой здесь незачем, человек сверяет список с карточкой. Стадия провала — названием причины
 * (сведённым, `reasonMerge`), остальные — кодом как есть: справочника стадий сделок в отчёте нет.
 *
 * @param sourceName источник ВСЕГО списка названием — когда он отобран не по полю сделки
 */
export function dealDrillRow(row: B24DrillDealRow, dictionaries: ReportDictionaries, keyByCode: Record<string, string> = {}, scope: DrillRequest['dealScope'] = 'from-leads', sourceName?: string): DrillRow {
  const id = toId(row.ID)
  const stage = toText(row.STAGE_ID)
  const reasonKey = keyByCode[stage]
  // Имя стадии знает только тот отчёт, у которого есть справочник выбранного направления
  // («Сделки по менеджерам»). У отчёта по лидам его нет — там печатается код, как и раньше.
  const stageName = dictionaries.dealStages?.[stage]
  const source = toText(row.SOURCE_ID)
  const when = toText(scope === 'unlinked' ? row.CLOSEDATE : row.DATE_CREATE)
  const amount = Number(row.OPPORTUNITY)
  const manager = managerLabel(dictionaries, toId(row.ASSIGNED_BY_ID))
  return {
    id,
    title: toText(row.TITLE) || `Сделка #${id}`,
    ...(when ? { when } : {}),
    ...(stage ? { stage: reasonKey ? lossReasonLabel(dictionaries, reasonKey) : (stageName ?? stage) } : {}),
    // ⚠ Подпись источника, приехавшая со списком, ГЛАВНЕЕ собственного поля сделки — и это не
    // произвол. Список «успешные сделки источника» отобран по источнику ЛИДА; у сделки он бывает
    // пуст или свой (54 расхождения из 261 на боевом портале), и под заголовком «… : Звонок»
    // встали бы строки с пустым источником. Собственное поле показывается там, где список по
    // нему и отобран, — тогда подписи в нагрузке нет.
    ...(sourceName ? { source: sourceName } : source ? { source: sourceLabel(dictionaries, source) } : {}),
    ...(manager ? { manager } : {}),
    ...(Number.isFinite(amount) ? { amount } : {}),
    ...(toText(row.CURRENCY_ID) ? { currencyId: toText(row.CURRENCY_ID) } : {}),
    path: crmPath('deal', id)
  }
}

/** Название вида дела CRM — то же слово, что в столбце таблицы отчёта. */
const DEED_LABEL: Record<number, string> = {
  1: 'Встреча',
  2: 'Звонок',
  3: 'Задача',
  4: 'Письмо',
  6: 'Дело'
}

/**
 * Строка дела CRM → строка списка.
 *
 * ⚠ Дата берётся по СМЫСЛУ числа: у дел за период это дата создания, а у просроченных — СРОК
 * (`END_TIME`), потому что число посчитано именно по нему. Покажи мы просроченному делу дату
 * создания — список с датами трёхлетней давности встал бы под числом «просрочено к концу
 * периода», и сверить их было бы нечем. Тот же приём, что у `dealScope: 'unlinked'`.
 *
 * ⚠ Направление печатается только у тех видов, у которых оно есть: у встреч и задач портал ставит
 * `DIRECTION: 0` всем записям, и столбец «направление: —» был бы шумом в каждой строке.
 */
export function activityDrillRow(
  row: B24DrillActivityRow,
  dictionaries: ReportDictionaries,
  scope: 'created' | 'overdue' = 'created'
): DrillRow {
  const id = toId(row.ID)
  const typeId = Number(row.TYPE_ID)
  const direction = Number(row.DIRECTION)
  const kind = DEED_LABEL[typeId] ?? 'Дело'
  const stage = direction === 1 || direction === 2
    // ⛔ У дел CRM `1` — ВХОДЯЩЕЕ, `2` — исходящее: обратно шкале телефонии (`CALL_TYPE`).
    ? `${kind}, ${direction === 1 ? 'входящее' : 'исходящее'}`
    : kind
  const when = toText(scope === 'overdue' ? row.END_TIME : row.CREATED)
  const manager = managerLabel(dictionaries, toId(row.RESPONSIBLE_ID))
  const section = ownerSection(row.OWNER_TYPE_ID)
  const ownerId = toId(row.OWNER_ID)
  return {
    id,
    title: toText(row.SUBJECT) || `${kind} #${id}`,
    ...(when ? { when } : {}),
    stage,
    ...(manager ? { manager } : {}),
    // Карточки самого дела в портале нет — открывается запись, к которой оно привязано.
    ...(section && ownerId ? { path: crmPath(section, ownerId) } : {})
  }
}

/**
 * Строка звонка → строка списка.
 *
 * ⚠ Название строки — НОМЕР телефона: у звонка нет ни темы, ни заголовка, а номер — единственное,
 * по чему человек узнаёт разговор в списке. Скрытый номер портал отдаёт пустым, и тогда остаётся
 * «Звонок #id».
 *
 * ⚠ Длительность печатается в столбце суммы (`amount`) БЕЗ валюты: столбец в списке один, а
 * длительность — то самое, ради чего этот список открывают. Валюта у него не ставится, иначе
 * секунды напечатались бы как деньги.
 */
export function callDrillRow(row: B24DrillCallRow, dictionaries: ReportDictionaries): DrillRow {
  const id = toId(row.ID)
  const seconds = Number(row.CALL_DURATION)
  // ⛔ `CALL_TYPE: 1` — ИСХОДЯЩИЙ, `2` — входящий: обратно шкале дел CRM (`DIRECTION`).
  const outgoing = Number(row.CALL_TYPE) !== 2
  const answered = String(row.CALL_FAILED_CODE ?? '') === '200'
  const manager = managerLabel(dictionaries, toId(row.PORTAL_USER_ID))
  const phone = toText(row.PHONE_NUMBER)
  return {
    id,
    title: phone || `Звонок #${id}`,
    ...(toText(row.CALL_START_DATE) ? { when: toText(row.CALL_START_DATE) } : {}),
    stage: `${outgoing ? 'Исходящий' : 'Входящий'}${answered ? '' : ', не дозвонились'}`,
    ...(manager ? { manager } : {}),
    ...(Number.isFinite(seconds) ? { amount: seconds } : {})
  }
}
