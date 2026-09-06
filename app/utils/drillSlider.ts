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
  /**
   * Как разбирать строки сделки: `unlinked` берёт дату ЗАКРЫТИЯ, остальные — создания.
   *
   * ⚠ Без этого признака список «успешные сделки без лида» показывал бы дату создания под
   * числом, посчитанным по дате закрытия: сделка, закрытая в сентябре и созданная в мае, попадала
   * бы в сентябрьский список с датой «май». Список, не сходящийся с числом над ним, хуже
   * отсутствующего списка.
   */
  dealScope?: 'from-leads' | 'unlinked' | 'plain'
  /** Направление сделок — по нему берутся ИМЕНА стадий: у каждого направления они свои. */
  categoryId?: number
  /**
   * Готовые подписи стадий, код → название, — те же слова, что стоят в отчёте.
   *
   * ⚠ Нужны потому, что подпись причины провала НЕ равна названию стадии ни в одном справочнике
   * портала: у заказчика одна причина — это пять-шесть кодов из разных направлений с разным
   * регистром и тире вместо дефиса, и отчёт сводит их в одно каноничное название
   * (`reasonMerge.ts`). Слайдер — отдельный фрейм: пересчитывать это сведение он не может, а
   * прочитанный им справочник ОДНОГО направления дал бы либо чужое название, либо голый код.
   * Строка «Отказ - Дорого: 15» открывала бы список из пятнадцати `C4:APOLOGY`.
   *
   * ⚠ Едут подписи только тех кодов, что стоят в фильтре, — их единицы. Класть сюда весь
   * справочник нельзя: нагрузка идёт через параметры вызова портала, и длинную по дороге усечёт.
   */
  stageNames?: Record<string, string>
  /** Заголовок слайдера — та же подпись, что у числа, по которому нажали. */
  title: string
  /** ПОЛНЫЙ фильтр списка REST: период, отбор отчёта и условие клетки уже сведены вместе. */
  filter: DrillFilter
  /** Число, по которому нажали, — чтобы сказать «показано M из N», не долистывая до конца. */
  total?: number
}

/**
 * Значение фильтра REST: строка, число, `null` или список строк и чисел.
 *
 * ⚠ `null` здесь ОБЯЗАТЕЛЕН, и это не послабление. Отчёт по лидам берёт сделки условием
 * `'!LEAD_ID': null` — «у сделки есть лид». Отвергни разбор `null`, и ВСЕ списки сделок этого
 * отчёта («успешные из лидов», «проигранные», разрезы по причинам и источникам) открывали бы
 * пустой слайдер с плашкой «нечего показывать» при совершенно исправном отчёте.
 */
export type DrillFilterValue = string | number | null | Array<string | number>
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

/** Пределы нагрузки: см. `decodeDrillPayload`. С запасом к самому широкому нашему фильтру. */
const MAX_FILTER_KEYS = 50
const MAX_LIST_ITEMS = 1000
/** Подписей стадий — по числу кодов ОДНОЙ причины провала (у заказчика их шесть), с запасом. */
const MAX_STAGE_NAMES = 50

/** Годное значение фильтра — или `undefined`, если портал прислал что-то другое. */
function readFilterValue(value: unknown): DrillFilterValue | undefined {
  if (typeof value === 'string') return value
  // ⚠ `null` — значимое условие REST («поле пусто»), а не «значения нет». См. `DrillFilterValue`.
  if (value === null) return null
  // ⚠ `Number.isFinite`, а не `typeof === 'number'`: `NaN` и `Infinity` пролезли бы в фильтр и
  // ушли бы в портал строкой «NaN» — список вернулся бы пустым без единого сигнала.
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!Array.isArray(value)) return undefined
  if (value.length > MAX_LIST_ITEMS) return undefined
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
 * Подписи стадий из нагрузки — или `undefined`, если их не прислали либо прислали негодные.
 *
 * ⚠ В отличие от фильтра, негодные подписи нагрузку НЕ отвергают: подпись — удобство, а не
 * условие. Список без неё покажет те же записи кодом стадии, а вот отказ открыть список из-за
 * косметики оставил бы человека без данных вовсе. Опасные ключи при этом всё равно отбрасываются:
 * `stageNames['__proto__'] = '…'` молча не создаёт своего поля, и код стадии остался бы без
 * подписи при заполненной на вид карте.
 */
function readStageNames(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const keys = Object.keys(source)
  if (!keys.length || keys.length > MAX_STAGE_NAMES) return undefined
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (!Object.hasOwn(source, key) || UNSAFE_KEYS.has(key)) continue
    const name = source[key]
    if (typeof name === 'string' && name.trim()) out[key] = name
  }
  return Object.keys(out).length ? out : undefined
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
  // ⚠ Потолок на размер: нагрузка едет через портал, и очень длинный фильтр по дороге может быть
  // усечён — а усечённый JSON разбор отвергнет уже здесь, целиком, вместо того чтобы показать
  // список по половине условия. Числа взяты с запасом: у самого широкого нашего фильтра девять
  // ключей и списки в десятки кодов.
  if (Object.keys(source).length > MAX_FILTER_KEYS) return undefined
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
  const dealScope = data.dealScope === 'from-leads' || data.dealScope === 'unlinked' || data.dealScope === 'plain'
    ? data.dealScope
    : undefined
  const categoryId = typeof data.categoryId === 'number' && Number.isInteger(data.categoryId) && data.categoryId >= 0
    ? data.categoryId
    : undefined
  const stageNames = readStageNames(data.stageNames)

  return {
    entity,
    title,
    filter,
    ...(dealScope === undefined ? {} : { dealScope }),
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(stageNames === undefined ? {} : { stageNames }),
    ...(total === undefined ? {} : { total })
  }
}
