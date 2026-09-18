/**
 * Приведение сырых значений REST к типам, с которыми можно считать.
 *
 * ⚠ Вынесено из `b24Adapter.ts` не ради размера, а чтобы валюты уехали в свой модуль без
 * кольцевого импорта: `b24Currency` нужны эти две функции, а адаптеру — валюты. Знания об
 * отчёте здесь нет никакого, только «портал отдаёт числа строками, а пустоту — null».
 *
 * ⚠ Нечитаемое значение здесь — НОЛЬ и пустая строка, а не `NaN`/`undefined`. Один `NaN`,
 * прошедший дальше, превращает в `NaN` всю сумму, в которую попал, и на экране это «NaN» без
 * единого указания, какая строка портала его дала.
 *
 * ⚠ У отчёта 3 (`activityLoad.ts`) свой `toNumber`, и он НЕ такой: `Number(value)` без разбора
 * типа. На строках и пустотах портала они совпадают, а на `true` и `['5']` — нет. Свести их
 * значит поменять поведение разбора звонков, а это не переезд файла; пока оставлены обе.
 */

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
export function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}
