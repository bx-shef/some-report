import { toNumber, toText } from '~/utils/b24Values'

/**
 * Валюты портала: курсы, приведение суммы и ответ на вопрос «что с валютой было не так».
 *
 * ⚠ Отдельным модулем — не ради размера, а потому что цена ошибки здесь выше, чем у остального
 * разбора: битая строка курса однажды дала курс 1 и завысила выручку в 28 раз при нулевых
 * оговорках. Числа при этом выглядели обычными.
 *
 * ⚠ `classifyCurrency` — ОДНА на оба места агрегации (сделки из лидов и блок 7). Считай каждое
 * само, число «не в базовой валюте» в оговорках разошлось бы с числом в блоке 7 на одном и том
 * же портале, и объяснить это было бы нечем. Отдельный модуль делает это правило видимым:
 * заводить вторую такую функцию здесь негде.
 */

/** Строка `crm.currency.list`. */
export interface B24CurrencyRow {
  CURRENCY: string
  BASE?: string | null
  AMOUNT?: string | number | null
  AMOUNT_CNT?: string | number | null
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
