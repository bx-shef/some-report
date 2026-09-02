import type { LeadOutcome, ReportDeal, ReportDictionaries, ReportLead } from '~/types/report'

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
   * Сделки, чей `LEAD_ID` указывает на лид ВНЕ выборки: он создан до начала периода либо удалён.
   *
   * ⚠ Считается отдельно от `dealsWithoutLead`, хотя для пользователя следствие то же — выручка
   * выпадает из разреза источников. Раньше такие сделки не считались вовсе: `LEAD_ID` непустой,
   * значит «с лидом», — и отчёт уверял, что осиротевших сделок ноль, пока они молча выпадали.
   */
  dealsWithMissingLead: number
  /**
   * Первое действие по лидам не выбиралось вовсе (`input.firstResponse` не передан).
   *
   * ⚠ Без этого признака блок «Обработка лидов» показал бы «обработано 0 %, просрочено 100 %» —
   * как факт о работе отдела, хотя это факт о том, что данных не запрашивали. Разные утверждения,
   * и первое клевещет на живых людей.
   */
  firstResponseNotFetched: boolean
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

  const dealsByLead = new Map<number, number[]>()
  const knownLeadIds = new Set(input.leads.map(row => toNumber(row.ID)))
  let dealsWithoutLead = 0
  let dealsWithMissingLead = 0
  let unconvertedDeals = 0

  const deals: ReportDeal[] = input.deals.map((row) => {
    const id = toNumber(row.ID)
    const leadId = toNumber(row.LEAD_ID)
    const dealCurrency = toText(row.CURRENCY_ID) || currencyId
    const { value, converted } = toBaseAmount(toNumber(row.OPPORTUNITY), dealCurrency, rates)
    if (!converted && dealCurrency !== currencyId) unconvertedDeals++

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

    const semantic = toSemantic(row.STAGE_SEMANTIC_ID)
    return {
      id,
      ...(leadId > 0 ? { leadId } : {}),
      sourceId: toText(row.SOURCE_ID),
      assignedById: toNumber(row.ASSIGNED_BY_ID),
      outcome: semantic === 'S' ? 'won' : semantic === 'F' ? 'lost' : 'in-work',
      amount: value,
      // Причина проигрыша — сама стадия провала. Отдельного поля причины в Битрикс24 нет
      // (docs/PORTAL.md §2), поэтому разбивка наполнится ровно тогда, когда в портале заведут
      // стадии под причины.
      ...(semantic === 'F' ? { lossReasonId: toText(row.STAGE_ID) } : {})
    }
  })

  let wonStageWithoutDeal = 0

  const leads: ReportLead[] = input.leads.map((row) => {
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
      lossReasons: statusNames(input.dealStages)
    },
    warnings: {
      unconvertedDeals,
      wonStageWithoutDeal,
      dealsWithoutLead,
      dealsWithMissingLead,
      firstResponseNotFetched: input.firstResponse === undefined
    }
  }
}
