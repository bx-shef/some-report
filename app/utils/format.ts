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
 * Доля → проценты, округлённые как на экране. Одна функция для `formatPercent` и для листов
 * Excel: два округления (`toFixed` и `Math.round`) расходятся на границах вроде 0,2875 —
 * экран печатал бы 28,7 %, файл 28,8, и человек нашёл бы «ошибку» там, где её нет.
 */
export function roundPercent(value: number, digits = 1): number {
  return Number((value * 100).toFixed(digits))
}

/**
 * Доля 0…1 как проценты.
 *
 * ⚠ `digits` по умолчанию `1`, но целые доли печатаются без «,0»: «80 %» вместо «80,0 %».
 * Так на макете, и так короче в плотных таблицах, где процент стоит рядом с числом.
 */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = roundPercent(value, digits)
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

/**
 * Длительность в СЕКУНДАХ человеческим текстом: `45` → `45 с`, `750` → `12 мин 30 с`,
 * `12345` → `3 ч 25 мин`.
 *
 * ⚠ Отдельно от `formatDuration`, который принимает минуты, и это не дублирование. Разговоры
 * копятся в секундах (округли каждый — и сумма сотни коротких уедет на десятки минут), а средний
 * разговор в 95 секунд через минутный формат напечатался бы как «2 мин»: единственное число,
 * ради которого этот столбец и смотрят, потеряло бы весь смысл.
 *
 * ⚠ `undefined` — это «разговоров не было», и печатается прочерком, а не нулём. Ноль означал бы
 * «разговоры были и длились нисколько» (то же правило, что у `averageCallSeconds`).
 */
export function formatSeconds(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} с`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} мин ${total % 60} с`
  const hours = Math.floor(minutes / 60)
  return `${hours} ч ${minutes % 60} мин`
}

/**
 * ISO-дата `YYYY-MM-DD` → `ДД.ММ.ГГГГ`.
 *
 * ⚠ Форматируем строкой, а не через `Date`: `new Date('2026-09-01')` разбирается как полночь UTC,
 * и в часовом поясе западнее Гринвича печаталось бы 31 августа. Для границ периода отчёта это
 * молчаливая ошибка на сутки в каждой подписи.
 */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-')
  if (!year || !month || !day) return iso
  return `${day}.${month}.${year}`
}
