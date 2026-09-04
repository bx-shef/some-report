import type { B24StatusRow } from '~/utils/b24Adapter'

/**
 * Сведение одноимённых причин из разных направлений сделок в одну строку отчёта.
 *
 * ⚠ Зачем. У заказчика четыре направления, и стадии проигрыша живут в каждом отдельно. Причина
 * «Отказ - дорого» на боевом портале — это ШЕСТЬ стадий: `LOSE`, `C1:LOSE`, `C3:LOSE`,
 * `C3:UC_CVXNKM` (дубль внутри одного направления), `C4:LOSE` и `10 | Отказ - дорого (удалить)`.
 * Ядро группирует по идентификатору и о направлениях знать не должно — иначе руководитель видит
 * «Дорого» шестью строками по 30 вместо одной по 180 и решает, что отчёт сломан.
 *
 * ⚠ Сводим по НАЗВАНИЮ, и название приходится чистить. На живых данных одна причина написана
 * «Отказ - Дорого», «Отказ - дорого», «Отказ -Нет нужного количества» и «Отказ – Нет нужного
 * количества» (тире вместо дефиса). Регистр, пробелы вокруг дефиса и сам знак дефиса — три
 * независимых способа получить шесть строк из одной.
 *
 * ⚠ Что НЕ сводим: разные названия. «Отказ - дорого (удалить)» — отдельная строка, хотя это
 * явно та же причина: стадия помечена к удалению, но на ней живут сделки, и это факт о гигиене
 * CRM, который должен быть виден, а не растворён.
 */

/**
 * Каноническая форма названия причины: одно на все написания.
 *
 * Правила — ровно те, что нужны живым данным, и ни одного «на всякий случай»: каждое лишнее
 * правило рискует склеить РАЗНЫЕ причины, а это хуже, чем не склеить одинаковые.
 */
export function normalizeReasonName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Все виды тире и минуса → дефис: `–` (en dash), `—` (em dash), `−` (минус), `‐` (hyphen).
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    // Пробелы вокруг дефиса не значат ничего: «Отказ -Нет» и «Отказ - Нет» — одно.
    .replace(/\s*-\s*/g, '-')
}

export interface MergedReason {
  /** Каноничный ключ — им помечаются сделки и по нему группирует ядро. */
  key: string
  /** Название для печати — самое аккуратное из встреченных написаний (см. `betterWritten`). */
  name: string
  /** Коды стадий, свёрнутые в этот ключ. Больше одного — сведение состоялось. */
  codes: string[]
}

export interface ReasonMerge {
  /** Код стадии → каноничный ключ. */
  keyByCode: Record<string, string>
  /** Каноничный ключ → название для печати. Ровно тот словарь, что нужен `lossReasonLabel`. */
  names: Record<string, string>
  /** Сведённые причины, включая одиночные. */
  reasons: MergedReason[]
  /** Сколько кодов «исчезло» при сведении: кодов всего минус причин. Ноль — сводить было нечего. */
  foldedCodes: number
}

/**
 * Префикс ключа — чтобы каноничный ключ не совпал ни с одним кодом стадии портала.
 *
 * ⚠ Без него причина, чьё нормализованное название случайно совпало с кодом другой стадии
 * (например, стадия с именем «lose»), склеилась бы с ней в словаре, и печаталось бы чужое имя.
 */
const KEY_PREFIX = 'reason:'

/**
 * Какое из двух написаний одной причины печатать.
 *
 * ⚠ На боевом портале направление по умолчанию идёт в справочнике первым, и половина его стадий
 * записана без пробела после дефиса: «Отказ -Не складской ассортимент». Печатать первое
 * встреченное значило бы показать руководителю то, что читается как НАША опечатка. Правило одно
 * и проверяемое: предпочитаем написание с дефисом в пробелах, при равенстве — первое.
 */
function betterWritten(current: string, candidate: string): string {
  const tidy = (name: string) => name.includes(' - ')
  return !tidy(current) && tidy(candidate) ? candidate : current
}

/**
 * Свести стадии провала по названию.
 *
 * Порядок строк важен и намеренно сохраняется: первым приходит справочник направления по
 * умолчанию, и при прочих равных печатается его написание. Стадия без названия остаётся под
 * своим кодом — сводить «пустоту с пустотой» значило бы склеить неизвестно что.
 */
export function mergeReasons(rows: readonly B24StatusRow[]): ReasonMerge {
  const keyByCode: Record<string, string> = Object.create(null)
  const names: Record<string, string> = Object.create(null)
  const byKey = new Map<string, MergedReason>()

  for (const row of rows) {
    const code = String(row.STATUS_ID ?? '').trim()
    if (!code || code in keyByCode) continue
    const rawName = String(row.NAME ?? '').trim()
    const normalized = normalizeReasonName(rawName)
    const key = normalized ? KEY_PREFIX + normalized : code

    keyByCode[code] = key
    const existing = byKey.get(key)
    if (existing) {
      existing.codes.push(code)
      existing.name = betterWritten(existing.name, rawName || code)
      names[key] = existing.name
      continue
    }
    const reason: MergedReason = { key, name: rawName || code, codes: [code] }
    byKey.set(key, reason)
    names[key] = reason.name
  }

  const reasons = [...byKey.values()]
  const codesTotal = reasons.reduce((sum, reason) => sum + reason.codes.length, 0)
  return { keyByCode, names, reasons, foldedCodes: codesTotal - reasons.length }
}
