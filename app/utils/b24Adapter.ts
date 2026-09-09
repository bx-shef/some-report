import { UNSPECIFIED_SOURCE, share, UNSPECIFIED_REASON, processingFromCounts } from '~/utils/metrics'
import { INITIAL_LEAD_STATUS } from '~/utils/leadHistory'
import { lockedFilterValue } from '~/utils/filters'
import type {
  DealsContext,
  UnlinkedDeals,
  UnlinkedDealsRow,
  LeadAggregate,
  ReportDeal
} from '~/types/report'

/**
 * Перевод сырых строк REST Битрикс24 в нормализованные лиды и сделки.
 *
 * Граница между «что отдал портал» и «что считает отчёт». Ядро (`metrics.ts`) про Битрикс24 не
 * знает ничего и потому тестируется без портала; здесь, наоборот, собрано всё портальное — и
 * каждое решение подпёрто замером живого REST (см. `docs/PORTAL.md`).
 *
 * ⚠ Берём КЛАССИЧЕСКИЕ `crm.lead.list` / `crm.deal.list`, а не универсальный `crm.item.list`.
 * Причина не в привычке: у `crm.item.list` для лидов `STATUS_ID` приезжает под именем `stageId`,
 * а неизвестное поле в `select` метод принимает БЕЗ ОШИБКИ и просто возвращает записи без него.
 * То есть опечатка в имени поля дала бы отчёт, где все лиды «в работе», и ни одного сигнала о том,
 * что что-то не так.
 */

/** Семантика стадии портала: `P` в работе, `S` успех, `F` провал. */
export type B24Semantic = 'P' | 'S' | 'F'

/** Строка `crm.lead.list`. Идентификаторы REST отдаёт СТРОКАМИ — приводим сами. */
export interface B24LeadRow {
  ID: string | number
  STATUS_ID?: string | null
  STATUS_SEMANTIC_ID?: string | null
  SOURCE_ID?: string | null
  ASSIGNED_BY_ID?: string | number | null
  DATE_CREATE?: string | null
}

/** Строка `crm.deal.list`. */
export interface B24DealRow {
  ID: string | number
  LEAD_ID?: string | number | null
  STAGE_ID?: string | null
  STAGE_SEMANTIC_ID?: string | null
  SOURCE_ID?: string | null
  ASSIGNED_BY_ID?: string | number | null
  OPPORTUNITY?: string | number | null
  CURRENCY_ID?: string | null
}

/** Строка `crm.currency.list`. */
export interface B24CurrencyRow {
  CURRENCY: string
  BASE?: string | null
  AMOUNT?: string | number | null
  AMOUNT_CNT?: string | number | null
}

/** Строка `crm.status.list` — элемент справочника (источники, стадии, причины). */
export interface B24StatusRow {
  STATUS_ID: string
  NAME?: string | null
  ENTITY_ID?: string | null
  /** Семантика стадии: `S` успех, `F` провал, пусто — в работе. Есть у стадий, нет у источников. */
  SEMANTICS?: string | null
}

/** Число из REST: приходит строкой, пустотой или null. Нечитаемое значение — это `0`, не `NaN`. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** Строка из REST: `null`/`undefined` → пустая строка, чтобы дальше не проверять их снова. */
function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}

function toSemantic(value: unknown): B24Semantic {
  const text = toText(value).toUpperCase()
  return text === 'S' || text === 'F' ? text : 'P'
}

/**
 * Курсы валют к базовой валюте портала.
 *
 * ⚠ Формула — `AMOUNT / AMOUNT_CNT`, а не просто `AMOUNT`: у российского рубля на живом портале
 * `AMOUNT=3.53` при `AMOUNT_CNT=100`, то есть курс задан ЗА СОТНЮ. Наивное умножение на `AMOUNT`
 * завысило бы такие сделки в сто раз — и в отчёте это выглядело бы как обычное большое число.
 */
export function currencyRates(rows: B24CurrencyRow[]): Record<string, number> {
  // `Object.create(null)` — защита в глубину: ключи приходят из портала, и словарь без прототипа
  // не даст записи вроде `__proto__` вести себя иначе, чем все остальные.
  const rates: Record<string, number> = Object.create(null)
  for (const row of rows) {
    const code = toText(row.CURRENCY)
    if (!code) continue
    const amount = toNumber(row.AMOUNT)
    const count = toNumber(row.AMOUNT_CNT)
    /**
     * ⚠ Битую строку курса ПРОПУСКАЕМ, а не подменяем единицей.
     *
     * Раньше здесь стояло `amount > 0 ? amount / count : 1`, и это был самый дорогой дефект
     * адаптера: валюта с пустым `AMOUNT` получала курс 1 к базовой, сделка на 456 000 RUB
     * превращалась в 456 000 BYN (завышение в 28 раз) — и `unconvertedDeals` при этом оставался
     * нулём, то есть отчёт об этом МОЛЧАЛ. Пропущенная строка уводит такую сделку в ветку
     * «неизвестная валюта»: сумма остаётся как есть и попадает в счётчик оговорок.
     *
     * Отрицательный `AMOUNT_CNT` отсекается тем же условием: он дал бы отрицательный курс и
     * отрицательную выручку, неотличимую в отчёте от честного возврата.
     */
    if (amount > 0 && count > 0) rates[code] = amount / count
  }
  return rates
}

/** Базовая валюта портала (`BASE = 'Y'`). Если её нет — берём первую, чтобы не остаться без валюты. */
export function baseCurrency(rows: B24CurrencyRow[]): string {
  return toText(rows.find(r => toText(r.BASE).toUpperCase() === 'Y')?.CURRENCY)
    || toText(rows[0]?.CURRENCY)
    || ''
}

/**
 * Сумма сделки в базовой валюте портала.
 *
 * ⚠ Неизвестный код валюты НЕ конвертируем и НЕ обнуляем — оставляем как есть и сообщаем об этом
 * наверх счётчиком. Обнулить значит тихо потерять выручку; сконвертировать по выдуманному курсу —
 * тихо её исказить. Оба варианта в отчёте выглядят как обычное число.
 */
export function toBaseAmount(
  amount: number,
  currencyId: string,
  rates: Record<string, number>
): { value: number, converted: boolean } {
  const rate = rates[currencyId]
  if (rate === undefined) return { value: amount, converted: false }
  return { value: amount * rate, converted: true }
}

/**
 * Сумма сделки в базовой валюте ПЛЮС ответ на вопрос «что с валютой было не так».
 *
 * ⚠ Одна функция на оба места агрегации (`dealFromRow` для сделок из лидов и
 * `adaptUnlinkedWonDeals` для блока 7) НАМЕРЕННО. Раньше каждое считало эти два условия само, и
 * любая правка одного — скажем, приведение кода валюты к верхнему регистру — молча расходилась бы
 * со вторым: число «не в базовой валюте» в оговорках отчёта разошлось бы с числом в блоке 7 на
 * одном и том же портале, и объяснить это было бы нечем.
 *
 * @returns `converted: false` — валюты нет в справочнике, сумма осталась КАК ЕСТЬ (сломано);
 *   `foreign: true` — валюта известна и не базовая, сумму привели курсом (посчитано верно, но
 *   заводить такую сделку не следовало).
 *
 * ⚠ У известной чужой валюты истинны ОБА флага: она и приведена, и чужая. Инвариант тут не
 * «флаги исключают друг друга», а «`foreign` влечёт `converted`» — то есть в ДВА СЧЁТЧИКА одна
 * сделка попасть не может, потому что первый растёт по `!converted`. Формулировка «оба флага
 * одновременно не бывают» стояла здесь и была неверна; поймал её тест на инвариант, а не чтение.
 */
export function classifyCurrency(
  amount: number,
  dealCurrencyId: string,
  baseCurrencyId: string,
  rates: Record<string, number>
): { value: number, converted: boolean, foreign: boolean } {
  const { value, converted } = toBaseAmount(amount, dealCurrencyId, rates)
  const isBase = dealCurrencyId === baseCurrencyId
  return {
    value,
    // Своя валюта портала конвертации не требует — это не «не удалось привести».
    converted: converted || isBase,
    foreign: !isBase && converted
  }
}

/** Справочник `crm.status.list` → код: имя. */
export function statusNames(rows: B24StatusRow[]): Record<string, string> {
  // Без прототипа: ключи приходят из портала (см. `currencyRates`).
  const names: Record<string, string> = Object.create(null)
  for (const row of rows) {
    const id = toText(row.STATUS_ID)
    if (id) names[id] = toText(row.NAME) || id
  }
  return names
}

/** Что адаптер хочет сказать о качестве данных — чтобы отчёт не молчал о своих оговорках. */
export interface AdapterWarnings {
  /** Сделки в валюте, курса которой в портале нет: суммы взяты как есть, без конвертации. */
  unconvertedDeals: number
  /**
   * Сделки в валюте, ОТЛИЧНОЙ от базовой: сумма приведена курсом и сложена с остальными.
   *
   * ⚠ Это не то же, что `unconvertedDeals`, и путать их нельзя. Там валюта НЕИЗВЕСТНА — это
   * сломано, сумма взята как есть. Здесь всё сработало правильно: курс нашёлся, привели.
   *
   * ⚠ Показываем всё равно, потому что у заказчика это ошибка ВВОДА: «Все сделки в BYN. Судя по
   * всему сделки в рублях это неправильные сделки» (ответ от 2026-09-03). Приведённая курсом
   * сделка неотличима в выручке от правильной — ошибка растворяется, и найти её потом нельзя.
   */
  foreignCurrencyDeals: number
  /** Сделки без лида-родителя (`LEAD_ID` пуст): в разрез источников они не попадают. */
  dealsWithoutLead: number
  /**
   * Сколько кодов стадий провала свёрнуто в одноимённые причины (см. `reasonMerge.ts`).
   *
   * Показываем человеку не как ошибку, а как объяснение: «Отказ - дорого» в таблице одной
   * строкой, хотя в CRM это шесть стадий, — иначе он сверит с CRM и решит, что отчёт что-то
   * потерял.
   */
  mergedLossReasons: number
  /**
   * Записи с уже встречавшимся `ID`, выброшенные как повтор.
   *
   * ⚠ Признак сбоя ПАГИНАЦИИ: постраничный опрос вернул одну и ту же страницу дважды. Без
   * дедупликации лид считался бы дважды, а из двух сделок с одним `ID` ядро оставляло бы в своей
   * карте только последнюю — и «успешные сделки» в сводке разошлись бы с выручкой по источникам
   * без единой подсказки, почему.
   */
  duplicateIds: number
  /**
   * Успешные сделки с нулевой суммой. Не ошибка отчёта — свойство процесса в CRM: на портале
   * заказчика деньги оформляются на сделках без лида, а сделка из лида закрывается с нулём.
   */
  wonWithoutAmount: number
}

/** Одна строка `crm.deal.list` → сделка отчёта. `converted: false` — валюта без курса. */
function dealFromRow(
  row: B24DealRow,
  rates: Record<string, number>,
  currencyId: string,
  reasonKeyByCode: Record<string, string>
): { deal: ReportDeal, converted: boolean, foreign: boolean } {
  const id = toNumber(row.ID)
  const leadId = toNumber(row.LEAD_ID)
  const dealCurrency = toText(row.CURRENCY_ID) || currencyId
  /**
   * ⚠ `foreign` — валюта ЗНАЕТСЯ, но она не базовая: сумму привели курсом и сложили с остальными.
   * Считаем отдельно от `converted` потому, что у заказчика это не «сделка в другой валюте», а
   * ОШИБКА ВВОДА: «Все сделки в BYN. Судя по всему сделки в рублях это неправильные сделки»
   * (ответ от 2026-09-03). Привести её курсом и молча сложить значит растворить ошибку в
   * выручке — никто её больше не найдёт и не исправит.
   */
  const { value, converted, foreign } = classifyCurrency(toNumber(row.OPPORTUNITY), dealCurrency, currencyId, rates)
  const semantic = toSemantic(row.STAGE_SEMANTIC_ID)
  return {
    converted,
    foreign,
    deal: {
      id,
      ...(leadId > 0 ? { leadId } : {}),
      sourceId: toText(row.SOURCE_ID),
      assignedById: toNumber(row.ASSIGNED_BY_ID),
      outcome: semantic === 'S' ? 'won' : semantic === 'F' ? 'lost' : 'in-work',
      amount: value,
      // Причина проигрыша — сама стадия провала. Отдельного поля причины в Битрикс24 нет
      // (docs/PORTAL.md §2), поэтому разбивка наполнится ровно тогда, когда в портале заведут
      // стадии под причины.
      //
      // ⚠ Помечаем не кодом стадии, а каноничным ключом причины: одна причина в четырёх
      // направлениях — это разные коды, и ядро, группируя по коду, печатало бы её четырьмя
      // строками. Код, которого нет в справочнике, остаётся кодом — его хотя бы можно найти в CRM.
      ...(semantic === 'F' ? { lossReasonId: reasonKeyByCode[toText(row.STAGE_ID)] ?? toText(row.STAGE_ID) } : {})
    }
  }
}

/**
 * Только сделки, без лидов — для режима счётчиков, где лиды приходят итогами.
 *
 * Сюда попадают сделки ИЗ ЛИДОВ (выборка уже отфильтрована по `LEAD_ID`), поэтому «сделка без
 * лида» здесь — не оговорка, а признак того, что фильтр запроса поехал; такие считаем и отдаём
 * наверх, чтобы это было видно.
 */
export function adaptDeals(
  rows: B24DealRow[],
  currencies: B24CurrencyRow[],
  /**
   * Код стадии провала → каноничный ключ причины (`mergeReasons(lossStages(…)).keyByCode`).
   *
   * ⚠ Принимаем ГОТОВУЮ карту, а не справочник: вызывающий строит и словарь имён, и эту карту
   * из одного `mergeReasons`, и рассинхрон между тем, чем помечена сделка, и тем, под чем лежит
   * её имя, становится невозможен по построению. Пересчёт здесь из справочника оставлял бы два
   * места, которым надо совпасть.
   */
  reasonKeyByCode: Record<string, string> = {}
): { deals: ReportDeal[], unconvertedDeals: number, foreignCurrencyDeals: number, dealsWithoutLead: number, duplicateIds: number, wonWithoutAmount: number } {
  const rates = currencyRates(currencies)
  const currencyId = baseCurrency(currencies)
  const seen = new Set<number>()
  let duplicateIds = 0
  let unconvertedDeals = 0
  let foreignCurrencyDeals = 0
  let dealsWithoutLead = 0
  let wonWithoutAmount = 0
  const deals: ReportDeal[] = []
  for (const row of rows) {
    const id = toNumber(row.ID)
    if (seen.has(id)) {
      duplicateIds++
      continue
    }
    seen.add(id)
    const { deal, converted, foreign } = dealFromRow(row, rates, currencyId, reasonKeyByCode)
    if (!converted) unconvertedDeals++
    if (foreign) foreignCurrencyDeals++
    if (deal.leadId === undefined) dealsWithoutLead++
    /**
     * ⚠ Успешная сделка с нулевой суммой — не мелочь, а свойство процесса. На боевом портале
     * заказчика ВСЕ 636 успешных сделок из лидов за август имеют `OPPORTUNITY = 0`: деньги там
     * живут на сделках, заведённых без лида. «Выручка: 0 BYN» без этого счётчика читалась бы как
     * «отчёт сломан», а это вопрос к тому, как в CRM оформляют продажу.
     */
    if (deal.outcome === 'won' && deal.amount === 0) wonWithoutAmount++
    deals.push(deal)
  }
  return { deals, unconvertedDeals, foreignCurrencyDeals, dealsWithoutLead, duplicateIds, wonWithoutAmount }
}

/**
 * Только стадии провала — то, из чего складываются причины проигрыша.
 *
 * ⚠ Сводить надо ИМЕННО их. Стадии «Новая», «Обработка», «Успех» тоже продублированы во всех
 * направлениях, и сведение по всему справочнику давало бы счётчик «стадий свёрнуто» втрое больше
 * правды: на экране он объясняет, почему строк в таблице причин меньше, чем стадий, — и
 * с чужими стадиями внутри не сходился бы ни с чем.
 */
export function lossStages(rows: readonly B24StatusRow[]): B24StatusRow[] {
  return rows.filter(row => toSemantic(row.SEMANTICS) === 'F' && toText(row.SEMANTICS) !== '')
}

export function statusIdsBySemantic(rows: B24StatusRow[], semantic: B24Semantic): string[] {
  return rows
    .filter(row => toSemantic(row.SEMANTICS) === semantic && toText(row.SEMANTICS) !== '')
    .map(row => toText(row.STATUS_ID))
    .filter(Boolean)
}

/**
 * Открытые стадии лида — все, у которых нет семантики «успех»/«провал»: `NEW`, «взято в работу»
 * и что ещё заведёт портал. По ним блок 6 раскладывает лиды, не дошедшие до сделки.
 */
export function openLeadStatusIds(rows: B24StatusRow[]): string[] {
  return rows
    .filter(row => toSemantic(row.SEMANTICS) !== 'S' && toSemantic(row.SEMANTICS) !== 'F')
    .map(row => toText(row.STATUS_ID))
    .filter(Boolean)
}

/**
 * Ключи счётчиков лидов — ОДИН словарь для того, кто спрашивает, и того, кто разбирает ответ.
 *
 * ⚠ Ключи собираются функциями, а не пишутся строками в двух местах: разъехавшийся ключ не даёт
 * ошибки — он даёт ноль в нужной клетке отчёта, и выглядит это как «в этом источнике лидов не
 * было».
 */
export const leadCountKey = {
  total: 'total',
  junk: 'junk',
  converted: 'converted',
  inWork: 'inWork',
  junkReason: (statusId: string) => `junk:${statusId}`,
  /** Лиды, которые до сих пор в «Не обработан». */
  unprocessed: 'unprocessed',
  /** Открытые лиды на конкретной стадии. */
  stage: (statusId: string) => `stage:${statusId}`,
  source: (sourceId: string) => `src:${sourceId}`,
  sourceJunk: (sourceId: string) => `srcJunk:${sourceId}`,
  sourceConverted: (sourceId: string) => `srcConv:${sourceId}`
} as const

export interface LeadCountsInput {
  /** Открытые стадии лида — для разбивки блока 6. Нет — разбивки нет. */
  openStatusIds?: readonly string[]
  /**
   * Фрагмент фильтра лидов, под которым собран пакет (`leadRestFilter`). По нему адаптер знает,
   * что счётчик `NEW` под фильтром по другой стадии не спрашивали, потому что он — ноль.
   */
  leadFilter?: Record<string, string | number>
  /** Ключ (см. `leadCountKey`) → `total` из ответа портала. Отсутствующий ключ читается как 0. */
  totals: Record<string, number>
  /** Коды источников, по которым спрашивали. */
  sourceIds: string[]
  /** Коды стадий брака, по которым спрашивали. */
  junkStatusIds: string[]
}

/**
 * Счётчики портала → агрегат лидов для ядра.
 *
 * ⚠ «Источник не указан» НЕ спрашивается у портала отдельно — он вычисляется как остаток:
 * всего минус сумма по известным источникам. Фильтр по пустому `SOURCE_ID` в REST ведёт себя
 * по-разному от версии к версии, а остаток — арифметика, которая не зависит ни от чего.
 *
 * ⚠ «Квалифицирован» здесь — стадия с семантикой «успех» (`CONVERTED`), а не «есть сделка», как
 * при построчном разборе: сделки в счётчиках не видны. На портале заказчика это одно и то же по
 * смыслу — стадия так и называется «Квалифицировано», — но на портале, где лиды конвертируют в
 * контакт без сделки, эти два числа разойдутся. Об этом сказано в `docs/METRICS.md`.
 */
export function adaptLeadCounts(input: LeadCountsInput): LeadAggregate {
  const get = (key: string): number => Math.max(0, toNumber(input.totals[key]))
  const total = get(leadCountKey.total)
  const junk = get(leadCountKey.junk)
  const qualified = get(leadCountKey.converted)
  const inWork = get(leadCountKey.inWork)

  const junkByReason: Record<string, number> = Object.create(null)
  let junkKnown = 0
  for (const statusId of input.junkStatusIds) {
    const count = get(leadCountKey.junkReason(statusId))
    if (count > 0) junkByReason[statusId] = count
    junkKnown += count
  }
  // ⚠ Брак на стадии, которой нет в справочнике (удалена, переименована), в итоге по семантике
  // ЕСТЬ, а в разбивке по стадиям — нет. Без остатка таблица причин недосчитывала бы этих лидов
  // молча; со остатком они лежат в «причина не указана» — как и при построчном разборе.
  if (junk - junkKnown > 0) junkByReason[UNSPECIFIED_REASON] = junk - junkKnown

  const bySource: Record<string, { leads: number, junk: number, qualified: number }> = Object.create(null)
  let known = { leads: 0, junk: 0, qualified: 0 }
  for (const sourceId of input.sourceIds) {
    const row = {
      leads: get(leadCountKey.source(sourceId)),
      junk: get(leadCountKey.sourceJunk(sourceId)),
      qualified: get(leadCountKey.sourceConverted(sourceId))
    }
    if (row.leads > 0) bySource[sourceId] = row
    known = { leads: known.leads + row.leads, junk: known.junk + row.junk, qualified: known.qualified + row.qualified }
  }
  const rest = {
    leads: Math.max(0, total - known.leads),
    junk: Math.max(0, junk - known.junk),
    qualified: Math.max(0, qualified - known.qualified)
  }
  if (rest.leads > 0) bySource[UNSPECIFIED_SOURCE] = rest

  // Открытые лиды по стадиям — только если стадии передали; счётчик, которого не спрашивали, — ноль.
  // Под фильтром по стадии, отличной от `NEW`, «не обработано» — ноль по построению, и пакет его
  // не спрашивал (см. `leadCountBatch`); без фильтра отсутствующий ключ значит «не считали».
  const lockedStatus = lockedFilterValue(input.leadFilter ?? {}, 'STATUS_ID')
  const unprocessed = leadCountKey.unprocessed in input.totals
    ? Math.min(total, get(leadCountKey.unprocessed))
    : lockedStatus !== undefined && lockedStatus !== INITIAL_LEAD_STATUS ? 0 : undefined
  let byOpenStage: Record<string, number> | undefined
  if (input.openStatusIds) {
    byOpenStage = Object.create(null) as Record<string, number>
    for (const statusId of input.openStatusIds) {
      // `NEW` в пакете не спрашивали второй раз — его число и есть «не обработано».
      const count = statusId === INITIAL_LEAD_STATUS ? (unprocessed ?? 0) : get(leadCountKey.stage(statusId))
      if (count > 0) byOpenStage[statusId] = count
    }
  }

  return {
    total,
    junk,
    qualified,
    inWork,
    closedWithoutDeal: Math.max(0, total - junk - qualified - inWork),
    junkByReason,
    bySource,
    ...(unprocessed === undefined ? {} : { unprocessed }),
    ...(byOpenStage ? { byOpenStage } : {}),
    // «Обработано» по счётчику `NEW` — сразу; время и просрочка приходят позже, из истории.
    ...(unprocessed === undefined ? {} : { processing: processingFromCounts(total, unprocessed) })
    // `leadSourceById` намеренно отсутствует: строк лидов нет.
  }
}

/**
 * Строки `crm.lead.list` (`ID` + `SOURCE_ID`) → карта «лид → источник» для `sourceRows`.
 *
 * ⚠ Ключ источника ТОТ ЖЕ, что у `adaptLeadCounts`: источник, которого нет в справочнике
 * (удалили после того, как лиды им пометились), уходит в остаток `UNSPECIFIED_SOURCE`. Иначе
 * карта отдала бы код, строки под который в разрезе нет, и сделка молча выпала бы из таблицы —
 * при полностью исправной выборке.
 *
 * @param knownSourceIds коды источников из справочника: по ним же спрашивались счётчики лидов
 */
export function leadSourcesById(
  rows: readonly B24LeadRow[],
  knownSourceIds: readonly string[] = []
): Record<number, string> {
  const known = new Set(knownSourceIds)
  // Без прототипа: ключи приходят из портала (см. `currencyRates`).
  const map: Record<number, string> = Object.create(null)
  for (const row of rows) {
    const id = toNumber(row.ID)
    if (id <= 0) continue
    const source = toText(row.SOURCE_ID)
    map[id] = source && known.has(source) ? source : UNSPECIFIED_SOURCE
  }
  return map
}

/** Ключи счётчиков сделок всего портала. */
export const dealCountKey = { won: 'dealsWon', lost: 'dealsLost', inWork: 'dealsInWork' } as const

/**
 * Успешные сделки без лида (строки `crm.deal.list` по `unlinkedWonDealsParams`) → блок 7.
 *
 * Суммы приводятся к базовой валюте тем же `classifyCurrency`, что и сделки из лидов, и теми же
 * ДВУМЯ счётчиками: неизвестная валюта остаётся как есть и считается в `unconverted` (сломано,
 * выручку сверять не с чем), известная неба́зовая приводится курсом и считается в `foreign`
 * (посчитано верно, но заводить такую сделку не следовало).
 * Пустой источник — своя строка `UNSPECIFIED_SOURCE`: на боевом портале это главная строка
 * блока (95 % таких сделок без источника), и прятать её в «прочее» значило бы спрятать сам факт.
 *
 * Сортировка по сумме, затем по количеству: блок про деньги, которые прошли мимо лидов.
 */
export function adaptUnlinkedWonDeals(
  rows: B24DealRow[],
  currencies: B24CurrencyRow[],
  /**
   * Коды источников из справочника. Код, которого там нет (источник удалили), идёт в строку
   * «не указан или удалён» — как обещает её подпись; иначе он печатался бы голым кодом.
   */
  knownSourceIds: readonly string[] = []
): UnlinkedDeals {
  const known = new Set(knownSourceIds)
  const rates = currencyRates(currencies)
  const currencyId = baseCurrency(currencies)
  const seen = new Set<number>()
  const bySource = new Map<string, { count: number, revenue: number }>()
  let total = 0
  let revenue = 0
  let unconverted = 0
  let foreign = 0
  for (const row of rows) {
    const id = toNumber(row.ID)
    // ⚠ Отсеиваем ПОВТОРЫ, а не записи без идентификатора: `toNumber` отдаёт 0 и для пустого, и
    // для непонятного `ID`, и «пропускать нулевой как виденный» значило бы выбросить из итога и
    // выручки все такие строки, кроме первой, — молча и без единого признака.
    if (id > 0) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const dealCurrency = toText(row.CURRENCY_ID) || currencyId
    const classified = classifyCurrency(toNumber(row.OPPORTUNITY), dealCurrency, currencyId, rates)
    const value = classified.value
    if (!classified.converted) unconverted++
    if (classified.foreign) foreign++
    const rawSource = toText(row.SOURCE_ID)
    const sourceId = rawSource && known.has(rawSource) ? rawSource : UNSPECIFIED_SOURCE
    const acc = bySource.get(sourceId) ?? { count: 0, revenue: 0 }
    acc.count++
    acc.revenue += value
    bySource.set(sourceId, acc)
    total++
    revenue += value
  }
  const result: UnlinkedDealsRow[] = [...bySource.entries()]
    .map(([sourceId, acc]) => ({
      sourceId,
      count: acc.count,
      share: share(acc.count, total),
      revenue: acc.revenue,
      shareOfRevenue: share(acc.revenue, revenue)
    }))
    .sort((a, b) => b.revenue - a.revenue || b.count - a.count || a.sourceId.localeCompare(b.sourceId))
  return { total, revenue, unconverted, foreign, totalShareOfRevenue: share(revenue, revenue), rows: result }
}

/** Счётчики сделок всего портала → контекст для сводки. */
export function adaptDealsContext(totals: Record<string, number>): DealsContext {
  const get = (key: string): number => Math.max(0, toNumber(totals[key]))
  return { won: get(dealCountKey.won), lost: get(dealCountKey.lost), inWork: get(dealCountKey.inWork) }
}

/** Строка `user.get` — только то, что нужно фильтру по менеджеру. */
export interface B24UserRow {
  ID: string | number
  NAME?: string | null
  LAST_NAME?: string | null
  /** `false` — сотрудник уволен. Портал отдаёт это поле и при `user_brief`. */
  ACTIVE?: boolean | string | null
  /**
   * Отделы сотрудника — МАССИВ идентификаторов, а не одно число.
   *
   * ⚠ Тип нарочно широкий: у отчёта нет права требовать от портала форму этого поля. На боевом
   * портале приезжает `[181]`, но у сотрудника без отдела поле может не прийти вовсе, а
   * совместитель (их у заказчика 13) приходит с несколькими. Разбирает это `adaptUserDepartments`.
   */
  UF_DEPARTMENT?: unknown
}

/**
 * Сотрудники → отделы каждого: id сотрудника → идентификаторы его отделов.
 *
 * ⚠ Разбираем ПРОВЕРЯЯ, а не приведением типа. Поле пользовательское (`UF_`), портал волен
 * прислать его массивом, строкой или не прислать вовсе, и слепое `as number[]` уронило бы фильтр
 * отдела на первом же нестандартном профиле. Негодное значение — это «отделов не знаем», то есть
 * пустой список: человек просто не попадёт ни в один отдел фильтра, а отчёт продолжит считать.
 *
 * ⚠ Сотрудник БЕЗ отделов в словарь не попадает вовсе. Пустой массив и отсутствие ключа тут одно
 * и то же, а лишние ключи только раздували бы объект на 329 человек.
 */
export function adaptUserDepartments(rows: readonly B24UserRow[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const row of rows) {
    const id = Number(row.ID)
    if (!Number.isFinite(id) || id <= 0) continue
    const raw = Array.isArray(row.UF_DEPARTMENT) ? row.UF_DEPARTMENT : []
    const departments = raw
      .map(value => Number(value))
      .filter(value => Number.isFinite(value) && value > 0)
    if (departments.length) out[String(id)] = departments
  }
  return out
}

/**
 * Сотрудники → словарь для фильтра по менеджеру: «Фамилия Имя».
 *
 * Без имени и фамилии (техническая учётка, обезличенный профиль) — «Сотрудник #id»: пустая
 * строка в выпадающем списке неотличима от пробела, а выбрать её всё равно можно.
 */
export function adaptUsers(rows: readonly B24UserRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const id = Number(row.ID)
    if (!Number.isFinite(id) || id <= 0) continue
    const name = [row.LAST_NAME, row.NAME].map(part => (part ?? '').trim()).filter(Boolean).join(' ')
    out[String(id)] = name || `Сотрудник #${id}`
  }
  return out
}
