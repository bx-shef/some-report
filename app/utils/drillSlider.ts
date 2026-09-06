import type { DrillEntity } from '~/utils/drilldown'

/**
 * Что передаётся странице детализации, открытой НАСТОЯЩИМ слайдером портала.
 *
 * ⚠ Полезная нагрузка САМОДОСТАТОЧНА: полный фильтр списка, а не «добавка» к отбору отчёта.
 * Слайдер открывается ОТДЕЛЬНЫМ фреймом — состояния отчёта, его периода и фильтров там нет
 * вовсе, и собрать их заново было бы вторым местом, где живёт одно и то же условие. Расходятся
 * такие места всегда, и замечают это на боевых данных.
 *
 * ⚠ Обратно значение приезжает ОТ ПОРТАЛА (`placement.options`), то есть снаружи. Разбор здесь
 * проверяющий, а не доверяющий: то же правило, что у сохранённого отбора (`savedFilters.ts`).
 * Негодную нагрузку страница обязана отвергнуть целиком — список, собранный по половине условия,
 * покажет НЕ те записи под верным заголовком, а это хуже пустого экрана.
 */
export interface DrillSliderPayload {
  entity: DrillEntity
  /** Заголовок слайдера — та же подпись, что у числа, по которому нажали. */
  title: string
  /** ПОЛНЫЙ фильтр списка REST: период, отбор отчёта и условие клетки уже сведены вместе. */
  filter: DrillFilter
  /** Число, по которому нажали, — чтобы сказать «показано M из N», не долистывая до конца. */
  total?: number
}

/** Значение фильтра REST: строка, число или список строк — больше портал в фильтре и не принимает. */
export type DrillFilterValue = string | number | Array<string | number>
export type DrillFilter = Record<string, DrillFilterValue>

/**
 * Имя параметра, под которым нагрузка едет в слайдер.
 *
 * ⚠ Одной строкой, а не набором полей: параметры вызова портал передаёт как есть, и вложенный
 * объект по дороге превращался бы в `[object Object]` у одних версий SDK и уезжал бы целиком у
 * других. Строка переживает любой транспорт.
 */
export const DRILL_PAYLOAD_KEY = 'payload'

/**
 * `place`, по которому открытый фрейм узнаёт, что он — детализация.
 *
 * ⚠ Это параметр ВЫЗОВА, а не зарегистрированный плейсмент: `openSliderAppPage` открывает нашу
 * же страницу по `place` из параметров. Значит, `placement.bind` не нужен, а переустановка
 * приложения на боевых порталах — тем более.
 */
export const DRILL_SLIDER_PLACE = 'app-drill'

/** Ширина слайдера в пикселях: список в семь колонок на меньшей ширине начинает переносить строки. */
export const DRILL_SLIDER_WIDTH = 900

/** Нагрузка → параметры вызова `openSliderAppPage`. */
export function encodeDrillPayload(payload: DrillSliderPayload): Record<string, string> {
  return {
    place: DRILL_SLIDER_PLACE,
    [DRILL_PAYLOAD_KEY]: JSON.stringify(payload)
  }
}

/** Имена, которые нельзя класть ключом в обычный объект, — см. шапку `decodeDrillPayload`. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Годное значение фильтра — или `undefined`, если портал прислал что-то другое. */
function readFilterValue(value: unknown): DrillFilterValue | undefined {
  if (typeof value === 'string') return value
  // ⚠ `Number.isFinite`, а не `typeof === 'number'`: `NaN` и `Infinity` пролезли бы в фильтр и
  // ушли бы в портал строкой «NaN» — список вернулся бы пустым без единого сигнала.
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!Array.isArray(value)) return undefined
  const items: Array<string | number> = []
  for (const item of value) {
    if (typeof item === 'string') items.push(item)
    else if (typeof item === 'number' && Number.isFinite(item)) items.push(item)
    // Один негодный элемент делает негодным весь список: отбросив его молча, мы показали бы
    // список ШИРЕ запрошенного — записи, которых за нажатым числом нет.
    else return undefined
  }
  return items
}

/**
 * Параметры вызова → нагрузка. `undefined` — прислали негодное, страница обязана сказать об этом.
 *
 * ⚠ Опасные имена ключей отвергают нагрузку ЦЕЛИКОМ. `__proto__` со строковым значением прошёл
 * бы проверку значения, а присваивание `filter['__proto__'] = 'NEW'` не создаёт своего поля —
 * оно молча ничего не делает. Условие исчезло бы из фильтра, и список оказался бы ШИРЕ числа, по
 * которому нажали, — под верным заголовком. Это ровно тот случай, который замечают на боевых
 * данных и не могут объяснить.
 */
export function decodeDrillPayload(options: unknown): DrillSliderPayload | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const raw = (options as Record<string, unknown>)[DRILL_PAYLOAD_KEY]
  if (typeof raw !== 'string' || !raw.trim()) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const data = parsed as Record<string, unknown>

  const entity = data.entity
  if (entity !== 'lead' && entity !== 'deal') return undefined
  const title = typeof data.title === 'string' ? data.title.trim() : ''
  if (!title) return undefined
  if (typeof data.filter !== 'object' || data.filter === null || Array.isArray(data.filter)) return undefined

  const source = data.filter as Record<string, unknown>
  const filter: DrillFilter = {}
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(source, key)) continue
    // См. шапку: такой ключ не «пропускаем», а отвергаем всю нагрузку.
    if (UNSAFE_KEYS.has(key)) return undefined
    const value = readFilterValue(source[key])
    // Негодное значение — негодная нагрузка целиком: см. шапку про «половину условия».
    if (value === undefined) return undefined
    filter[key] = value
  }
  // Пустой фильтр — это «покажи вообще всё»: под заголовком «Сделки: Минск · Иванов» человек
  // увидел бы весь портал. Такое приходит только от подделанного значения, и его отвергаем.
  if (!Object.keys(filter).length) return undefined

  const total = typeof data.total === 'number' && Number.isInteger(data.total) && data.total >= 0
    ? data.total
    : undefined

  return { entity, title, filter, ...(total === undefined ? {} : { total }) }
}
