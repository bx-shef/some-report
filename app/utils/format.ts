/**
 * Форматирование чисел для отчёта. Отдельным модулем и с тестами, потому что отчёт — это почти
 * целиком числа: одна расходящаяся с остальными строка обесценивает всю таблицу.
 *
 * Локаль зафиксирована (`ru-RU`), а не взята из браузера: иначе один и тот же отчёт у клиента и у
 * нас разделял бы разряды по-разному, и сравнить скриншоты становилось бы невозможно.
 */

const LOCALE = 'ru-RU'

/** Целое с неразрывными пробелами между разрядами: `1250` → `1 250`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value)
}

/**
 * Доля 0…1 как проценты.
 *
 * ⚠ `digits` по умолчанию `1`, но целые доли печатаются без «,0»: «80 %» вместо «80,0 %».
 * Так на макете, и так короче в плотных таблицах, где процент стоит рядом с числом.
 */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  const pct = value * 100
  const rounded = Number(pct.toFixed(digits))
  const fraction = Number.isInteger(rounded) ? 0 : digits
  return `${new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction
  }).format(rounded)} %`
}

/**
 * Деньги: `485000` + `BYN` → `485 000 BYN`.
 *
 * Код валюты печатается СУФФИКСОМ как есть, а не через `style: 'currency'`: в портале валюта —
 * произвольный код из справочника Битрикс24 (`crm.currency.list`), и `Intl` на незнакомом коде
 * бросает исключение прямо во время отрисовки отчёта.
 */
export function formatMoney(value: number, currencyId: string): string {
  if (!Number.isFinite(value)) return '—'
  const amount = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value)
  return currencyId ? `${amount} ${currencyId}` : amount
}

/**
 * Длительность в минутах человеческим текстом: `95` → `1 ч 35 мин`, `42` → `42 мин`,
 * `2880` → `2 дн 0 ч`. Больше двух единиц не показываем — точность здесь никому не нужна,
 * а длинная строка ломает плотную карточку.
 */
export function formatDuration(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes)) return '—'
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} мин`
  const hours = Math.floor(total / 60)
  if (hours < 24) return `${hours} ч ${total % 60} мин`
  return `${Math.floor(hours / 24)} дн ${hours % 24} ч`
}
