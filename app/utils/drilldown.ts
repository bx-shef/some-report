import type { ReportDataset, ReportDeal, ReportDictionaries, ReportFilters, ReportPeriod } from '~/types/report'
import { periodFilter, unlinkedWonDealsParams } from '~/utils/b24Query'
import { applyFilters, dealRestFilter, demoLeadHasStatus, demoLeadStatus, leadRestFilter, needsLeadIds, stageCodesFor } from '~/utils/filters'
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

export type DrillEntity = 'lead' | 'deal'

export interface DrillRequest {
  entity: DrillEntity
  /** Как подписано число, по которому нажали, — заголовок слайдера. */
  title: string
  /**
   * Условие поверх периода и фильтров отчёта: стадия, семантика, источник. У `dealScope: 'plain'`
   * это ПОЛНЫЙ фильтр списка — там отчёт строит его сам, целиком (матрица менеджеров).
   */
  extra: Record<string, string | string[] | number>
  /**
   * Сделки: из лидов (как в воронке — период по дате создания, фильтры отчёта действуют),
   * без лида (блок 7: по дате закрытия, `LEAD_ID` пуст, только успешные, фильтры не действуют)
   * или `plain` — фильтр целиком в `extra`, ни периода отчёта по лидам, ни его фильтров
   * (отчёт «Сделки по менеджерам»: там свой отбор — направление, охват, офис, менеджер, стадия).
   */
  dealScope?: 'from-leads' | 'unlinked' | 'plain'
  /** Число, по которому нажали, — чтобы слайдер говорил «показано M из N», не долистывая до конца. */
  total?: number
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
  path: string
}

/** Поля строк для списка. `TITLE` — то, по чему человек узнаёт запись; остальное — подписи. */
export const DRILL_LEAD_SELECT = ['ID', 'TITLE', 'DATE_CREATE', 'STATUS_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID'] as const
export const DRILL_DEAL_SELECT = ['ID', 'TITLE', 'DATE_CREATE', 'CLOSEDATE', 'STAGE_ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'CURRENCY_ID'] as const

/** Строка `crm.lead.list` для списка. */
export interface B24DrillLeadRow {
  ID: string | number
  TITLE?: string | null
  DATE_CREATE?: string | null
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
  /** Разрез по источнику: лиды, брак, квалифицировано — лиды; успешные — сделки из лидов. */
  bySource: (sourceId: string, part: 'leads' | 'junk' | 'qualified' | 'won', label: string): DrillRequest | undefined => {
    if (sourceId === UNSPECIFIED_SOURCE) return undefined
    switch (part) {
      case 'leads': return lead(`Лиды: ${label}`, { SOURCE_ID: sourceId })
      case 'junk': return lead(`Брак лидов: ${label}`, { SOURCE_ID: sourceId, STATUS_SEMANTIC_ID: 'F' })
      case 'qualified': return lead(`Квалифицировано: ${label}`, { SOURCE_ID: sourceId, STATUS_SEMANTIC_ID: 'S' })
      case 'won': return dealFromLeads(`Успешные сделки из лидов: ${label}`, { SOURCE_ID: sourceId, STAGE_SEMANTIC_ID: 'S' })
    }
  },
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
  filter: Record<string, unknown>
  /**
   * Сделки под фильтром по менеджеру или стадии лида — только по списку ID лидов (`LEAD_ID in`),
   * как и в самом отчёте; список у композабла, здесь только признак.
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
 * менеджерам» — направление, охват, офис, менеджер, стадия. Ни периода отчёта по лидам, ни его
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
  const byLeadIds = needsLeadIds(filters)
  const base = { ...periodFilter(period), ...(byLeadIds ? {} : { '!LEAD_ID': null }), ...dealRestFilter(filters, codesByReason) }
  return {
    method: 'crm.deal.list',
    select: [...DRILL_DEAL_SELECT],
    filter: { ...base, ...request.extra },
    byLeadIds,
    empty: conflicts(base, request.extra)
  }
}

/** Путь карточки в CRM портала — для `slider.openPath`; вне портала он никуда не ведёт. */
export function crmPath(entity: DrillEntity, id: number): string {
  return `/crm/${entity}/details/${id}/`
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

/** Строка лида портала → строка списка. Без названия — «Лид #id»: пустая строка в списке неотличима от отступа. */
export function leadDrillRow(row: B24DrillLeadRow, dictionaries: ReportDictionaries): DrillRow {
  const id = toId(row.ID)
  const status = toText(row.STATUS_ID)
  const source = toText(row.SOURCE_ID)
  const manager = managerLabel(dictionaries, toId(row.ASSIGNED_BY_ID))
  return {
    id,
    title: toText(row.TITLE) || `Лид #${id}`,
    ...(toText(row.DATE_CREATE) ? { when: toText(row.DATE_CREATE) } : {}),
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
 */
export function dealDrillRow(row: B24DrillDealRow, dictionaries: ReportDictionaries, keyByCode: Record<string, string> = {}, scope: DrillRequest['dealScope'] = 'from-leads'): DrillRow {
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
    ...(source ? { source: sourceLabel(dictionaries, source) } : {}),
    ...(manager ? { manager } : {}),
    ...(Number.isFinite(amount) ? { amount } : {}),
    ...(toText(row.CURRENCY_ID) ? { currencyId: toText(row.CURRENCY_ID) } : {}),
    path: crmPath('deal', id)
  }
}

function matchesCondition(value: string, condition: string | string[] | number | undefined, negate = false): boolean {
  if (condition === undefined) return true
  // Числа приводим к строке: в фильтре REST `MYCOMPANY_ID: 10` и `'10'` — одно и то же (по сети
  // всё равно уходит текст), и демо-набор обязан сравнивать их так же.
  const hit = Array.isArray(condition) ? condition.map(String).includes(value) : String(condition) === value
  return negate ? !hit : hit
}

/**
 * Те же списки для демо-набора — по строкам, чтобы предпросмотр открывал слайдер с теми же
 * числами, что на экране. Карточек в CRM у демо-строк нет (`path` пуст). Сделок без лида в
 * демо-наборе нет — список блока 7 пуст.
 */
export function demoDrillRows(request: DrillRequest, dataset: ReportDataset, filters: ReportFilters): DrillRow[] {
  const rows = applyFilters(dataset.leads, dataset.deals, filters)
  const { extra } = request
  if (request.entity === 'lead') {
    return rows.leads
      .filter((item) => {
        // «Успех» в демо — сконвертированный (со сделкой), как `isQualified` в ядре: «потерян» —
        // стадия успеха без сделки, в «квалифицировано» он не входит, и список не должен.
        const semantic = item.outcome === 'junk' ? 'F' : item.outcome === 'converted' ? 'S' : 'P'
        // Коды стадий приводим к строке: в фильтре REST число и строка — одно и то же.
        const wanted = extra.STATUS_ID === undefined ? [] : [extra.STATUS_ID].flat().map(String)
        const unwanted = extra['!STATUS_ID'] === undefined ? [] : [extra['!STATUS_ID']].flat().map(String)
        return matchesCondition(semantic, extra.STATUS_SEMANTIC_ID)
          && (!wanted.length || wanted.some(code => demoLeadHasStatus(item, code)))
          && !unwanted.some(code => demoLeadHasStatus(item, code))
          && matchesCondition(item.sourceId, extra.SOURCE_ID)
      })
      .map((item) => {
        const manager = managerLabel(dataset.dictionaries, item.assignedById)
        return {
          id: item.id,
          title: `Лид #${item.id}`,
          when: item.createdAt,
          stage: leadStageLabel(dataset.dictionaries, demoLeadStatus(item)),
          source: sourceLabel(dataset.dictionaries, item.sourceId),
          ...(manager ? { manager } : {}),
          path: ''
        }
      })
  }
  if (request.dealScope === 'unlinked') return []
  return rows.deals
    .filter((item: ReportDeal) => {
      const semantic = item.outcome === 'won' ? 'S' : item.outcome === 'lost' ? 'F' : 'P'
      const stage = item.lossReasonId ?? ''
      return matchesCondition(semantic, extra.STAGE_SEMANTIC_ID)
        && matchesCondition(stage, extra.STAGE_ID)
        && matchesCondition(stage, extra['!STAGE_ID'], true)
        && matchesCondition(item.sourceId, extra.SOURCE_ID)
    })
    .map((item) => {
      const manager = managerLabel(dataset.dictionaries, item.assignedById)
      return {
        id: item.id,
        title: `Сделка #${item.id}`,
        stage: item.outcome === 'won' ? 'Успешная' : item.outcome === 'lost' ? lossReasonLabel(dataset.dictionaries, item.lossReasonId ?? UNSPECIFIED_REASON) : 'В работе',
        source: sourceLabel(dataset.dictionaries, item.sourceId),
        ...(manager ? { manager } : {}),
        amount: item.amount,
        currencyId: dataset.currencyId,
        path: ''
      }
    })
}
