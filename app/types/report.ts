/**
 * Типы отчёта «Аналитика по лидам».
 *
 * Здесь ДВА разных слоя, и путать их нельзя:
 *
 * 1. **Вход** (`ReportLead`, `ReportDeal`) — уже НОРМАЛИЗОВАННЫЕ лид и сделка. Это не то, что
 *    отдаёт REST Битрикс24: сырые `STATUS_ID`, `STAGE_ID`, `CURRENCY_ID` у каждого портала свои,
 *    поэтому их разбор живёт в адаптере (`app/utils/b24Adapter.ts`), а ядро отчёта получает уже
 *    приведённые значения. Благодаря этому формулы тестируются без портала и без сети.
 * 2. **Выход** (`ReportMetrics` и его части) — посчитанные показатели. Доли здесь — ДРОБИ (0…1),
 *    а не проценты: округление до «80 %» делает форматтер на самом краю. Если округлять в ядре,
 *    сумма долей перестаёт сходиться к 100 %, и таблица начинает спорить сама с собой.
 */

/** Итог лида. Что считать «браком», решает адаптер по справочнику портала. */
export type LeadOutcome
  /** Лид ещё в работе: не закрыт, сделки нет. */
  = 'in-work'
  /** По лиду создана (или с ним связана) сделка — «квалифицирован». */
    | 'converted'
  /** Лид закрыт как брак: дубль, спам, нецелевой запрос, сервисное обращение. */
    | 'junk'
  /** Лид закрыт без сделки и без признака брака — потеря до сделки. */
    | 'lost'

/** Итог сделки — по семантике стадии (`crm.status.list`: `S` успех, `F` провал, иначе в работе). */
export type DealOutcome = 'in-work' | 'won' | 'lost'

/** Нормализованный лид. */
export interface ReportLead {
  id: number
  /** ISO-дата создания (`DATE_CREATE`). Отбор периода делает источник данных, не ядро. */
  createdAt: string
  /** Идентификатор источника (`SOURCE_ID`). Пустая строка — источник не заполнен. */
  sourceId: string
  /** Ответственный (`ASSIGNED_BY_ID`). `0` — не назначен. */
  assignedById: number
  outcome: LeadOutcome
  /**
   * Код причины закрытия для брака. Приходит из справочника причин отказа портала
   * (`STATUS_ID` вида `JUNK`/`UC_...`), поэтому это строка, а не перечисление: набор причин
   * настраивается в каждом портале свой.
   */
  junkReasonId?: string
  /** Сделки, созданные из лида. Непустой массив = лид квалифицирован. */
  dealIds: number[]
  /**
   * Когда по лиду впервые что-то сделали (первое дело/звонок/письмо), ISO.
   * `undefined` — лид ещё не трогали; такой лид считается необработанным.
   */
  firstResponseAt?: string
}

/** Нормализованная сделка. */
export interface ReportDeal {
  id: number
  /** Лид-родитель (`LEAD_ID`). `undefined` — сделка заведена руками, вне воронки лидов. */
  leadId?: number
  sourceId: string
  assignedById: number
  outcome: DealOutcome
  /**
   * Сумма сделки в ЕДИНОЙ валюте отчёта. Конвертацию делает адаптер: складывать `OPPORTUNITY`
   * в разных `CURRENCY_ID` — молчаливая арифметическая ошибка, которую в отчёте не видно.
   */
  amount: number
  /** Код причины проигрыша (справочник портала). `undefined` — причину не заполнили. */
  lossReasonId?: string
}

/**
 * Знаменатель конверсий — САМОЕ спорное место отчёта, поэтому это явный параметр, а не константа
 * внутри формулы.
 *
 * - `quality-leads` — «качественные лиды» = Всего − Брак. Так написано в ТЗ.
 * - `all-leads` — все лиды без вычета брака. Так посчитаны цифры на макете.
 *
 * Разница не косметическая: на данных макета одна и та же конверсия равна 100 % или 80 %.
 * Подробности и рекомендация — в `docs/METRICS.md`.
 */
export type ConversionBase = 'quality-leads' | 'all-leads'

/** Настройки расчёта. */
export interface ReportOptions {
  conversionBase: ConversionBase
  /**
   * Норматив первого ответа в минутах. Лид считается просроченным, если ответа не было вовсе
   * либо первый ответ пришёл позже норматива. `undefined` — норматив не задан, просроченные
   * не считаются (а не считаются нулём: ноль означал бы «всё в срок», это разные утверждения).
   */
  firstResponseSlaMinutes?: number
  /** Момент, относительно которого считается просрочка у ещё не отвеченных лидов (ISO). */
  now?: string
}

/**
 * Лиды в АГРЕГИРОВАННОМ виде — то, что ядру нужно на самом деле.
 *
 * ⚠ Заведено ради объёмов. На боевом портале заказчика 3 851 лид в месяц — 78 страниц выборки
 * ≈ 42 секунды ожидания, и всё ради того, чтобы ядро их пересчитало. Портал умеет считать сам:
 * `crm.lead.list` отдаёт `total` для любого фильтра, и 50 таких вопросов одним пакетом — это
 * две секунды. Поэтому ядро принимает не строки, а итоги; строки при этом никуда не делись —
 * демо-набор и тесты сворачивают их в этот же агрегат через `aggregateLeads`.
 *
 * Два пути обязаны давать один ответ на одних данных — это закреплено тестом.
 */
export interface LeadAggregate {
  total: number
  junk: number
  /** Квалифицированы: по строкам — есть сделка; по счётчикам — стадия с семантикой «успех». */
  qualified: number
  /** Ещё в работе. */
  inWork: number
  /** Закрыты без сделки и без признака брака — настоящие потери до сделки. */
  closedWithoutDeal: number
  /** Код стадии брака → сколько лидов. */
  junkByReason: Record<string, number>
  /** Разрез по источникам. Ключ — код источника, пустой источник — `UNSPECIFIED_SOURCE`. */
  bySource: Record<string, { leads: number, junk: number, qualified: number }>
  /**
   * Источник каждого лида по его идентификатору. Есть только когда лиды известны построчно:
   * по нему сделка находит источник СВОЕГО лида. По счётчикам карты нет — источник берётся у
   * самой сделки (при конвертации портал копирует его из лида).
   */
  leadSourceById?: Record<number, string>
  /**
   * Обработка лидов. `undefined` — время первого ответа не выбиралось, и блок обязан сказать
   * об этом, а не показать «обработано 0 %».
   */
  processing?: ProcessingMetrics
}

/**
 * Сделки ВСЕГО портала за период — счётчиками, для контекста.
 *
 * ⚠ Отчёт про путь ЛИДА, и строками он читает только сделки из лидов (`LEAD_ID` заполнен).
 * На боевом портале это каждая десятая сделка: остальные — прямой опт и интернет-магазин,
 * заведённые без лида. Без этих чисел «успешных сделок: 636» читалось бы как «компания продала
 * 636 раз за месяц», а это ложь в шесть раз.
 */
export interface DealsContext {
  won: number
  lost: number
  inWork: number
}

/** Сделки без связи с лидом по одному источнику. */
export interface UnlinkedDealsRow {
  /** Код источника; `UNSPECIFIED_SOURCE` — источник у сделки пуст; `UNKNOWN_SOURCE` — вне справочника. */
  sourceId: string
  count: number
  /** Доля от всех сделок без лида. */
  share: number
  won: number
}

/**
 * Сделки за период, у которых `LEAD_ID` пуст, — в разрезе источников.
 *
 * ⚠ Это не оговорка и не «ждём настройку связи» — это факт о процессе клиента, который отчёт
 * обязан ПОКАЗАТЬ. На боевом портале таких сделок 90 %, и почти все они ещё и без источника.
 * Приходит счётчиками (строк не читаем), поэтому ни выручки, ни причин — только количество.
 */
export interface UnlinkedDeals {
  /** Сделок без лида всего. */
  total: number
  /** Из них на стадии «успех». */
  won: number
  /** Доля от всех сделок периода. */
  shareOfAllDeals: number
  /** Строки по источникам, по убыванию; нулевые не входят. */
  rows: UnlinkedDealsRow[]
}

/** Строка «показатель + доля» — базовый кирпич всех разбивок. */
export interface CountShare {
  count: number
  /** Доля 0…1. */
  share: number
}

/** Сводка (KPI). */
export interface SummaryMetrics {
  totalLeads: number
  junk: number
  /** Доля брака — ВСЕГДА от всех лидов, независимо от `conversionBase`. */
  junkShare: number
  qualified: number
  /** Конверсия лид → сделка: `qualified / conversionBaseValue`. */
  qualifiedShare: number
  wonDeals: number
  /** Конверсия лид → продажа: `wonDeals / conversionBaseValue`. */
  wonShare: number
  revenue: number
  /** Какой знаменатель применён и чему он равен — чтобы число в отчёте можно было проверить. */
  conversionBase: ConversionBase
  conversionBaseValue: number
  /**
   * Сделки всего портала за период. `undefined` — источник их не считал (демо-набор).
   * Нужно, чтобы «успешных сделок: 636» не читалось как «компания продала 636 раз».
   */
  allDeals?: DealsContext
}

/** Ступень воронки. */
export interface FunnelStage {
  key: 'leads' | 'qualified' | 'won'
  label: string
  count: number
  /** Доля от знаменателя конверсий. У ступени «Лиды» равна 1 при базе `all-leads`. */
  share: number
}

/** Обработка лидов. */
export interface ProcessingMetrics {
  processed: number
  processedShare: number
  unprocessed: number
  unprocessedShare: number
  /** `undefined`, когда норматив первого ответа не задан. */
  overdue?: number
  overdueShare?: number
  /** Среднее время первого ответа в минутах. `undefined` — обработанных лидов нет. */
  avgFirstResponseMinutes?: number
  /** То же в разрезе источников. */
  bySource: Array<{ sourceId: string, processed: number, avgFirstResponseMinutes?: number }>
}

/** Строка разбивки брака. */
export interface JunkReasonRow {
  reasonId: string
  count: number
  /** Доля от всех лидов. */
  shareOfLeads: number
  /** Доля от брака. */
  shareOfJunk: number
}

/** Потери до сделки. */
export interface PreDealLossMetrics {
  /** По формуле ТЗ: Всего − Брак − Квалифицировано. */
  count: number
  /** Доля от знаменателя конверсий. */
  share: number
  /**
   * Из них ещё в работе. Выделено отдельно намеренно: формула ТЗ засчитывает такие лиды в
   * потери, хотя они ещё не потеряны, — и на коротком периоде это заметно завышает потери.
   */
  stillInWork: number
  /** Из них закрыты без сделки и без признака брака — настоящие потери. */
  closedWithoutDeal: number
}

/** Строка разбивки причин проигрыша сделок. */
export interface LossReasonRow {
  reasonId: string
  count: number
  /** Доля от проигранных сделок. */
  shareOfLost: number
  lostRevenue: number
  /** Доля от всей потерянной выручки. */
  shareOfLostRevenue: number
}

/** Проигранные сделки целиком. */
export interface LostDealsMetrics {
  count: number
  /** Доля от квалифицированных лидов — так подписано на макете. */
  shareOfQualified: number
  lostRevenue: number
  byReason: LossReasonRow[]
}

/** Строка таблицы эффективности источников. */
export interface SourceRow {
  sourceId: string
  leads: number
  junk: number
  junkShare: number
  qualified: number
  /** Конверсия лид → сделка внутри источника. */
  crToDeal: number
  won: number
  /** Конверсия лид → продажа внутри источника. */
  crToSale: number
  revenue: number
}

/** Всё, что считает ядро отчёта. */
export interface ReportMetrics {
  summary: SummaryMetrics
  funnel: FunnelStage[]
  /** `undefined` — время первого ответа не выбиралось; блок говорит об этом словами. */
  processing?: ProcessingMetrics
  junkByReason: JunkReasonRow[]
  preDealLoss: PreDealLossMetrics
  lostDeals: LostDealsMetrics
  bySource: SourceRow[]
  /** Топ-5 источников по количеству лидов. Подмножество `bySource`, не пересчёт. */
  topSources: SourceRow[]
}

/** Справочники портала: код → человеческое имя. Отчёт печатает имена, считает — по кодам. */
export interface ReportDictionaries {
  sources: Record<string, string>
  junkReasons: Record<string, string>
  lossReasons: Record<string, string>
}

/** Границы периода отчёта: ISO-даты `YYYY-MM-DD`, обе включительно. */
export interface ReportPeriod {
  from: string
  to: string
}

/** Всё, что нужно отчёту для расчёта: данные + справочники + валюта + период. */
export interface ReportDataset {
  leads: ReportLead[]
  deals: ReportDeal[]
  /**
   * Лиды итогами — когда источник считал их счётчиками, а не строками. Тогда `leads` пуст, а
   * ядро идёт через `buildReportFromAggregate`.
   */
  leadAggregate?: LeadAggregate
  /** Сделки всего портала за период, для контекста сводки. */
  allDeals?: DealsContext
  dictionaries: ReportDictionaries
  /** Код валюты, к которой приведены все суммы. */
  currencyId: string
  /** Границы периода — печатаются в шапке отчёта. */
  period: ReportPeriod
  /** Сделки без связи с лидом по источникам — только с портала (режим счётчиков). */
  unlinkedDeals?: UnlinkedDeals
}
