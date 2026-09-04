import { UNSPECIFIED_SOURCE, share, UNSPECIFIED_REASON } from '~/utils/metrics'
import { mergeReasons } from '~/utils/reasonMerge'
import type {
  DealsContext,
  UnlinkedDeals,
  UnlinkedDealsRow,
  LeadAggregate,
  LeadOutcome,
  ReportDeal,
  ReportDictionaries,
  ReportLead
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

/**
 * Итог лида по семантике его стадии и наличию сделок.
 *
 * ⚠ «Брак» определяется СЕМАНТИКОЙ (`F`), а не кодом `JUNK`. На тестовом портале стадия брака
 * сейчас одна, но заказчику предстоит завести свои («Дубль», «Спам», …) — и захардкоженный код
 * молча перестал бы их считать браком ровно в тот день, когда блок наконец наполнится данными.
 *
 * ⚠ Лид со стадией «успех», но без найденной сделки — отдельный случай, а не ошибка. Так бывает,
 * когда лид сконвертировали только в контакт или компанию, либо когда сделка вышла за границы
 * периода. Считать его квалифицированным нельзя (сделки нет), поэтому он попадает в «закрыт без
 * сделки», а сам факт считается отдельно и показывается как оговорка к данным.
 */
export function leadOutcome(semantic: B24Semantic, hasDeal: boolean): LeadOutcome {
  if (semantic === 'F') return 'junk'
  if (hasDeal) return 'converted'
  return semantic === 'S' ? 'lost' : 'in-work'
}

/** Что адаптер хочет сказать о качестве данных — чтобы отчёт не молчал о своих оговорках. */
export interface AdapterWarnings {
  /** Сделки в валюте, курса которой в портале нет: суммы взяты как есть, без конвертации. */
  unconvertedDeals: number
  /**
   * Лиды со стадией «успех», но без найденной сделки.
   *
   * ⚠ Имя про СТАДИЮ, а не про исход: сам лид получает `outcome: 'lost'` и попадает в «Потери до
   * сделки». Назвать поле `convertedWithoutDeal` значило бы спорить с типом `LeadOutcome`, где
   * `converted` означает «квалифицирован», то есть ровно обратное.
   */
  wonStageWithoutDeal: number
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
   * Сделки, чей `LEAD_ID` указывает на лид ВНЕ выборки: он создан до начала периода либо удалён.
   *
   * ⚠ Считается отдельно от `dealsWithoutLead`, хотя для пользователя следствие то же — выручка
   * выпадает из разреза источников. Раньше такие сделки не считались вовсе: `LEAD_ID` непустой,
   * значит «с лидом», — и отчёт уверял, что осиротевших сделок ноль, пока они молча выпадали.
   */
  dealsWithMissingLead: number
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
   * Первое действие по лидам не выбиралось вовсе (`input.firstResponse` не передан).
   *
   * ⚠ Без этого признака блок «Обработка лидов» показал бы «обработано 0 %, просрочено 100 %» —
   * как факт о работе отдела, хотя это факт о том, что данных не запрашивали. Разные утверждения,
   * и первое клевещет на живых людей.
   */
  firstResponseNotFetched: boolean
  /**
   * Успешные сделки с нулевой суммой. Не ошибка отчёта — свойство процесса в CRM: на портале
   * заказчика деньги оформляются на сделках без лида, а сделка из лида закрывается с нулём.
   */
  wonWithoutAmount: number
}

export interface AdaptedData {
  leads: ReportLead[]
  deals: ReportDeal[]
  dictionaries: ReportDictionaries
  currencyId: string
  warnings: AdapterWarnings
}

export interface AdapterInput {
  leads: B24LeadRow[]
  deals: B24DealRow[]
  currencies: B24CurrencyRow[]
  /** `crm.status.list` с `ENTITY_ID = SOURCE`. */
  sources: B24StatusRow[]
  /** `crm.status.list` с `ENTITY_ID = STATUS` — стадии лида; они же причины брака. */
  leadStatuses: B24StatusRow[]
  /** `crm.status.list` с `ENTITY_ID = DEAL_STAGE` — стадии сделки; они же причины проигрыша. */
  dealStages: B24StatusRow[]
  /**
   * Первое действие по лиду: идентификатор лида → ISO-дата. Собирается отдельно
   * (`crm.activity.list`), потому что в самих лидах этого поля нет.
   *
   * Не передан — блок «Обработка лидов» честно скажет, что данных не выбирали, вместо того чтобы
   * показать ноль обработанных.
   */
  firstResponse?: Record<number, string>
}

/** Одна строка `crm.deal.list` → сделка отчёта. `converted: false` — валюта без курса. */
function dealFromRow(
  row: B24DealRow,
  rates: Record<string, number>,
  currencyId: string,
  reasonKeyByCode: Record<string, string>
): { deal: ReportDeal, converted: boolean } {
  const id = toNumber(row.ID)
  const leadId = toNumber(row.LEAD_ID)
  const dealCurrency = toText(row.CURRENCY_ID) || currencyId
  const { value, converted } = toBaseAmount(toNumber(row.OPPORTUNITY), dealCurrency, rates)
  const semantic = toSemantic(row.STAGE_SEMANTIC_ID)
  return {
    // Своя валюта портала конвертации не требует — это не «не удалось привести».
    converted: converted || dealCurrency === currencyId,
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
): { deals: ReportDeal[], unconvertedDeals: number, dealsWithoutLead: number, duplicateIds: number, wonWithoutAmount: number } {
  const rates = currencyRates(currencies)
  const currencyId = baseCurrency(currencies)
  const seen = new Set<number>()
  let duplicateIds = 0
  let unconvertedDeals = 0
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
    const { deal, converted } = dealFromRow(row, rates, currencyId, reasonKeyByCode)
    if (!converted) unconvertedDeals++
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
  return { deals, unconvertedDeals, dealsWithoutLead, duplicateIds, wonWithoutAmount }
}

/**
 * Сырые ответы портала → то, что понимает ядро отчёта.
 *
 * ⚠ Связь «лид → сделки» строится ИЗ СДЕЛОК (`LEAD_ID`), а не из лидов: у лида поля со списком
 * сделок нет вовсе. На тестовом портале `LEAD_ID` пуст у всех сделок — тогда квалифицированных
 * не окажется ни одного, и это не дефект отчёта, а свойство портала (`docs/PORTAL.md` §3).
 */
export function adaptPortalData(input: AdapterInput): AdaptedData {
  const rates = currencyRates(input.currencies)
  const currencyId = baseCurrency(input.currencies)
  const reasons = mergeReasons(lossStages(input.dealStages))
  const reasonKeyByCode = reasons.keyByCode

  /**
   * Повторы по `ID` выбрасываем, оставляя ПЕРВОЕ вхождение.
   *
   * Первое, а не последнее, — потому что при сбое пагинации повтор приходит позже оригинала, и
   * «первое» означает «то, что портал отдал раньше». Выбор всё равно произвольный: одинаковые
   * `ID` — это сбой выборки, а не данные, и правильного ответа тут нет. Важно, что повтор не
   * проходит дальше молча, а попадает в счётчик оговорок.
   */
  let duplicateIds = 0
  const dedupe = <T>(rows: T[], id: (row: T) => number): T[] => {
    const seen = new Set<number>()
    return rows.filter((row) => {
      const key = id(row)
      if (seen.has(key)) {
        duplicateIds++
        return false
      }
      seen.add(key)
      return true
    })
  }

  const leadRows = dedupe(input.leads, row => toNumber(row.ID))
  const dealRows = dedupe(input.deals, row => toNumber(row.ID))

  const dealsByLead = new Map<number, number[]>()
  const knownLeadIds = new Set(leadRows.map(row => toNumber(row.ID)))
  let dealsWithoutLead = 0
  let dealsWithMissingLead = 0
  let unconvertedDeals = 0

  const deals: ReportDeal[] = dealRows.map((row) => {
    const { deal, converted } = dealFromRow(row, rates, currencyId, reasonKeyByCode)
    const { id, leadId = 0 } = deal
    if (!converted) unconvertedDeals++

    if (leadId <= 0) {
      dealsWithoutLead++
    } else if (!knownLeadIds.has(leadId)) {
      // Лид вне выборки: создан до начала периода либо удалён. Для пользователя следствие то же,
      // что и у сделки без лида, — выручка выпадает из разреза источников, — поэтому молчать
      // нельзя. Раньше такая сделка не считалась нигде: `LEAD_ID` непустой, значит «с лидом».
      dealsWithMissingLead++
    } else {
      // `push` в существующий массив, а не пересборка через spread: у лида с N сделками
      // пересборка давала бы O(N²) на ровном месте.
      const existing = dealsByLead.get(leadId)
      if (existing) existing.push(id)
      else dealsByLead.set(leadId, [id])
    }
    return deal
  })

  let wonStageWithoutDeal = 0

  const leads: ReportLead[] = leadRows.map((row) => {
    const id = toNumber(row.ID)
    const semantic = toSemantic(row.STATUS_SEMANTIC_ID)
    const dealIds = dealsByLead.get(id) ?? []
    const outcome = leadOutcome(semantic, dealIds.length > 0)
    if (semantic === 'S' && dealIds.length === 0) wonStageWithoutDeal++

    return {
      id,
      createdAt: toText(row.DATE_CREATE),
      sourceId: toText(row.SOURCE_ID),
      assignedById: toNumber(row.ASSIGNED_BY_ID),
      outcome,
      dealIds,
      ...(input.firstResponse?.[id] ? { firstResponseAt: input.firstResponse[id] } : {}),
      // Причина брака — сама стадия. Отдельного поля причины отказа у лида в Битрикс24 нет
      // (docs/PORTAL.md §1).
      ...(outcome === 'junk' ? { junkReasonId: toText(row.STATUS_ID) } : {})
    }
  })

  return {
    leads,
    deals,
    currencyId,
    dictionaries: {
      sources: statusNames(input.sources),
      junkReasons: statusNames(input.leadStatuses),
      // Словарь по каноничным ключам, а не по кодам: ключами помечены сделки.
      lossReasons: reasons.names
    },
    warnings: {
      mergedLossReasons: reasons.foldedCodes,
      unconvertedDeals,
      wonStageWithoutDeal,
      dealsWithoutLead,
      dealsWithMissingLead,
      duplicateIds,
      firstResponseNotFetched: input.firstResponse === undefined,
      wonWithoutAmount: deals.filter(d => d.outcome === 'won' && d.amount === 0).length
    }
  }
}

/** Коды стадий с заданной семантикой — например, все стадии брака лида (`F`). */
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
  source: (sourceId: string) => `src:${sourceId}`,
  sourceJunk: (sourceId: string) => `srcJunk:${sourceId}`,
  sourceConverted: (sourceId: string) => `srcConv:${sourceId}`
} as const

export interface LeadCountsInput {
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

  return {
    total,
    junk,
    qualified,
    inWork,
    closedWithoutDeal: Math.max(0, total - junk - qualified - inWork),
    junkByReason,
    bySource
    // `leadSourceById` и `processing` намеренно отсутствуют: строк лидов нет.
  }
}

/** Ключи счётчиков сделок всего портала. */
export const dealCountKey = { won: 'dealsWon', lost: 'dealsLost', inWork: 'dealsInWork' } as const

/**
 * Успешные сделки без лида (строки `crm.deal.list` по `unlinkedWonDealsParams`) → блок 7.
 *
 * Суммы приводятся к базовой валюте тем же `toBaseAmount`, что и сделки из лидов: неизвестная
 * валюта остаётся как есть и считается в `unconverted`, а не обнуляется и не выдумывается.
 * Пустой источник — своя строка `UNSPECIFIED_SOURCE`: на боевом портале это главная строка
 * блока (95 % таких сделок без источника), и прятать её в «прочее» значило бы спрятать сам факт.
 *
 * Сортировка по сумме, затем по количеству: блок про деньги, которые прошли мимо лидов.
 */
export function adaptUnlinkedWonDeals(rows: B24DealRow[], currencies: B24CurrencyRow[]): UnlinkedDeals {
  const rates = currencyRates(currencies)
  const currencyId = baseCurrency(currencies)
  const seen = new Set<number>()
  const bySource = new Map<string, { count: number, revenue: number }>()
  let total = 0
  let revenue = 0
  let unconverted = 0
  for (const row of rows) {
    const id = toNumber(row.ID)
    if (seen.has(id)) continue
    seen.add(id)
    const dealCurrency = toText(row.CURRENCY_ID) || currencyId
    const { value, converted } = toBaseAmount(toNumber(row.OPPORTUNITY), dealCurrency, rates)
    if (!converted && dealCurrency !== currencyId) unconverted++
    const sourceId = toText(row.SOURCE_ID) || UNSPECIFIED_SOURCE
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
  return { total, revenue, unconverted, rows: result }
}

/** Счётчики сделок всего портала → контекст для сводки. */
export function adaptDealsContext(totals: Record<string, number>): DealsContext {
  const get = (key: string): number => Math.max(0, toNumber(totals[key]))
  return { won: get(dealCountKey.won), lost: get(dealCountKey.lost), inWork: get(dealCountKey.inWork) }
}
