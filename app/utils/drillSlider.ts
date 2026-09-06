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
  /**
   * Как разбирать строки дела CRM: `overdue` берёт СРОК (`END_TIME`), остальные — дату создания.
   *
   * ⚠ По той же причине, что и `dealScope`. Число «просрочено» посчитано по сроку и без нижней
   * границы периода; покажи список дату создания — под ним встали бы даты трёхлетней давности, и
   * сверить список с числом было бы нечем.
   */
  activityScope?: 'created' | 'overdue'
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
   * ⚠ Едут подписи только тех кодов, что стоят в фильтре, — их единицы. Прежнее обоснование
   * («канал усечёт длинное») больше не действует: условие едет через `user.option`, размер ему не
   * помеха. Потолок остался по другой причине — запись приходит обратно через портал и разбирается
   * как недоверенная, а у недоверенного ввода границы обязаны быть.
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
 * Имя параметра, под которым в слайдер едет КЛЮЧ условия — короткая случайная строка.
 *
 * ⚠ Само условие здесь НЕ едет, и это выученный урок, а не осторожность. Параметры вызова
 * приходят фрейму через `PLACEMENT_OPTIONS`, а этот канал не выдерживает килобайтов: соседний
 * `client-bank-alfa-by` доверяет ему ровно один короткий скаляр (`place`) и знает случай, когда
 * на живом портале `PLACEMENT_OPTIONS` приехал ПУСТЫМ целиком. Мы положили туда JSON фильтра со
 * всеми подписями причин — короткий `place` доехал, JSON нет, и человек увидел «Список не
 * открылся» на исправном отчёте.
 *
 * Условие едет через `user.option` портала (`DRILL_OPTION_KEY`) — то же серверное хранилище, в
 * котором приложение уже запоминает отбор. Оно не зависит от того, как портал сериализует
 * параметры окна, размер ему не помеха, и нового права не нужно.
 */
export const DRILL_PAYLOAD_KEY = 'drill'

/**
 * Ключ `user.option`, под которым условие ждёт открывшийся слайдер.
 *
 * ⚠ Ключ ОДИН, а не «по ключу на клик»: записи в `user.option` никто не убирает, и отдельный ключ
 * на каждое открытие копил бы мусор в портале заказчика без конца. Одноразовость даёт не имя
 * ключа, а `nonce` ВНУТРИ значения.
 */
export const DRILL_OPTION_KEY = 'reportDrill'

/**
 * Одноразовый ключ условия.
 *
 * ⚠ Нужен потому, что запись одна на всех: нажали два числа подряд — второе перезапишет условие
 * первого. Слайдер, открытый первым нажатием, увидит несовпадение и скажет «условие устарело».
 * Это честный отказ; без `nonce` он молча показал бы ЧУЖОЙ список под верным заголовком, а это
 * ровно тот дефект, который замечают на боевых данных и не могут объяснить.
 */
export function newDrillNonce(): string {
  const random = globalThis.crypto?.randomUUID?.()
  // ⚠ Запасной путь без `crypto`: `nonce` здесь не секрет, а метка «то самое условие». Ему нужна
  // неповторяемость в пределах пары кликов, а не стойкость к подбору.
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Что лежит в `user.option`: условие и метка, по которой слайдер узнаёт СВОЁ. */
export interface DrillHandoff {
  nonce: string
  payload: DrillSliderPayload
}

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
export function encodeDrillCall(nonce: string): Record<string, string> {
  return {
    place: DRILL_SLIDER_PLACE,
    [DRILL_PAYLOAD_KEY]: nonce
  }
}

/** Условие + метка → строка для `user.option`. */
export function encodeDrillHandoff(nonce: string, payload: DrillSliderPayload): string {
  return JSON.stringify({ nonce, payload } satisfies DrillHandoff)
}

/**
 * `PLACEMENT_OPTIONS` → обычный объект.
 *
 * ⚠ Разбор нужен потому, что SDK кладёт эти данные КАК ЕСТЬ: в `placement.mjs` буквально
 * `this.#options = Object.freeze(data.PLACEMENT_OPTIONS)`, без всякой обработки. Портал волен
 * прислать их JSON-строкой, и тогда наивное `options.drill` молча даёт `undefined` — фрейм
 * показывает не то, что просили, а разобраться не по чему. Приём взят у `client-bank-alfa-by`,
 * где это выяснилось на живом портале.
 */
export function parsePlacementOptions(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
}

/**
 * Значение параметра вызова по имени, БЕЗ учёта регистра.
 *
 * ⚠ Регистр не наш: остальные поля init-данных портал шлёт заглавными (`PLACEMENT`, `LANG`,
 * `IS_ADMIN`), и рассчитывать на то, что наши ключи он оставит как есть, не на чем.
 */
function optionValue(options: Record<string, unknown>, name: string): string | undefined {
  for (const [key, value] of Object.entries(options)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    const text = typeof value === 'string' ? value.trim() : ''
    if (text) return text
  }
  return undefined
}

/**
 * Ключ условия, с которым открыт ЭТОТ фрейм: из параметров вызова, а если их нет — из адреса.
 *
 * ⚠ Второй источник не «на всякий случай». У `client-bank-alfa-by` живой портал прислал фрейму
 * слайдера ПУСТОЙ `PLACEMENT_OPTIONS` — читать оттуда было нечего, а приложение открывается по
 * своему адресу, и параметр приехал строкой запроса. Имя ищем и своё, и с приставкой `bx24_`:
 * так платформа переименовывает служебные параметры окна (`bx24_width`, `bx24_title`).
 */
export function drillNonceFrom(rawOptions: unknown, search = ''): string | undefined {
  const options = parsePlacementOptions(rawOptions)
  const fromOptions = optionValue(options, DRILL_PAYLOAD_KEY)
  if (fromOptions) return fromOptions
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    for (const [key, value] of params.entries()) {
      const name = key.toLowerCase()
      if (name !== DRILL_PAYLOAD_KEY && name !== `bx24_${DRILL_PAYLOAD_KEY}`) continue
      const text = value.trim()
      if (text) return text
    }
  } catch {
    // Негодная строка запроса — просто нет второго источника.
  }
  return undefined
}

/** Имена, которые нельзя класть ключом в обычный объект, — см. шапку `readDrillPayload`. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Поля CRM, по которым отчёт вообще умеет строить условие. Всё остальное нагрузку отвергает.
 *
 * ⚠ Белый список, а не «всё, кроме опасных имён», — и это не перестраховка. `openSliderAppPage`
 * открывает наш фрейм по параметру ВЫЗОВА: позвать его может любое приложение портала, у которого
 * есть доступ к `BX24`. Читать CRM оно будет НАШИМ токеном с правом `crm` — своего может и не
 * быть. Списком полей мы не даём чужому фильтру спросить у портала то, чего этот отчёт не
 * спрашивает никогда.
 *
 * ⚠ Пополнять список — вместе с новым условием в `drilldown.ts`/`managerQuery.ts`, иначе список
 * молча не откроется. Ровно поэтому он лежит здесь, а не «где-нибудь в конфиге»: рядом с разбором.
 */
const ALLOWED_FILTER_FIELDS = new Set([
  // Периоды: у лида и сделки — дата создания, у сделок без лида — дата закрытия, у истории —
  // CREATED_TIME.
  //
  // ⚠ `DATE_CLOSED` — дата закрытия ЛИДА, и это НЕ `CLOSEDATE` сделки: имена у портала разные, а
  // забытое здесь поле не ломает ничего заметного — список просто не открывается. Понадобилось
  // отчёту «Активность пользователей» (закрытые лиды считаются по дате закрытия).
  'DATE_CREATE', 'CLOSEDATE', 'DATE_CLOSED', 'CREATED_TIME',
  // Отбор отчёта и условия клеток.
  'ID', 'SOURCE_ID', 'ASSIGNED_BY_ID', 'STATUS_ID', 'STAGE_ID',
  'STATUS_SEMANTIC_ID', 'STAGE_SEMANTIC_ID', 'LEAD_ID', 'TYPE_ID',
  'CATEGORY_ID', 'MYCOMPANY_ID',
  // Отчёт «Активность пользователей», дела CRM: период по созданию, срок, вид, направление,
  // ответственный и признак выполнения.
  'CREATED', 'END_TIME', 'DIRECTION', 'COMPLETED', 'RESPONSIBLE_ID',
  // Он же, звонки телефонии.
  'CALL_START_DATE', 'PORTAL_USER_ID', 'CALL_FAILED_CODE', 'CALL_DURATION', 'CALL_TYPE'
])

/**
 * Ключ фильтра REST → имя поля без приставки сравнения (`!`, `>`, `<`, `>=`, `<=`).
 *
 * ⚠ Приставку снимаем, а не сверяем ключ целиком: иначе белый список пришлось бы вести в пяти
 * вариантах на каждое поле, и первый же забытый вариант закрыл бы рабочий список.
 */
function filterField(key: string): string {
  return key.replace(/^[!<>=]+/, '')
}

/** Пределы нагрузки: см. `readDrillPayload`. С запасом к самому широкому нашему фильтру. */
const MAX_FILTER_KEYS = 50
const MAX_LIST_ITEMS = 1000
/**
 * Подписей стадий — с запасом к 25 кодам провала четырёх направлений заказчика
 * ([`PORTAL.md`](../../docs/PORTAL.md)). Потолок держат ОБЕ стороны: отправитель обрезает
 * осмысленно, приёмник — на случай подделанной нагрузки.
 */
export const MAX_STAGE_NAMES = 50

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
  // ⚠ Пустой список — не «условие ни на что», а условие, которого портал НЕ ВИДИТ: `STAGE_ID: []`
  // он пропускает, и под заголовком одной причины провала открылся бы весь период. Отчёт таких
  // условий не строит вовсе — пустой отбор он решает без запроса.
  if (!value.length) return undefined
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
 * Открыт ли фрейм КАК детализация — по `place` из параметров вызова.
 *
 * ⚠ Отдельно от разбора нагрузки, и это важно: «открыли детализацию, но параметры негодные» и
 * «открыли приложение обычным способом» — РАЗНЫЕ случаи, и вести себя страница обязана по-разному.
 * В первом человек нажал на число и ждёт список: показать ему вместо списка оглавление
 * приложения значит соврать молча. Во втором оглавление — ровно то, что он и просил.
 */
export function isDrillFrame(options: unknown, search = ''): boolean {
  // ⚠ Через тот же разбор, что и ключ условия: `PLACEMENT_OPTIONS` приходит объектом ЛИБО
  // JSON-строкой, а регистр ключа задаёт портал, не мы.
  if (optionValue(parsePlacementOptions(options), 'place') === DRILL_SLIDER_PLACE) return true
  // Фрейм с ключом условия — детализация, даже если `place` по дороге потерялся: ключ мы кладём
  // сами и ни с чем не спутаем.
  return drillNonceFrom(options, search) !== undefined
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
  const out: Record<string, string> = {}
  // ⚠ Лишние подписи ОБРЕЗАЕМ, а не отвергаем все. Отвергнув, мы получили бы худший исход из
  // возможных: у заказчика четыре направления и 25 кодов провала, пятое направление перевалило
  // бы за потолок — и список, где не хватало бы нескольких подписей, вместо этого потерял бы ВСЕ,
  // показав пятнадцать `C4:APOLOGY` под заголовком «Отказ - Дорого».
  for (const key of Object.keys(source)) {
    if (Object.keys(out).length >= MAX_STAGE_NAMES) break
    if (!Object.hasOwn(source, key) || UNSAFE_KEYS.has(key)) continue
    const name = source[key]
    if (typeof name === 'string' && name.trim()) out[key] = name
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Разбор нагрузки: либо годная, либо ПРИЧИНА отказа.
 *
 * ⚠ Причина — не отладочная роскошь, а часть контракта. Отказ здесь видит человек, который нажал
 * на число и ждёт список; «негодные параметры» не говорит ни ему (что делать?), ни нам (что
 * чинить?). Отказов у разбора десяток, и по экрану они неразличимы — а чинятся по-разному:
 * обрезанная по дороге нагрузка и поле не из белого списка требуют противоположных действий.
 *
 * ⚠ В причине НЕТ данных CRM: имена ключей, длины и признаки — но не значения условия и не
 * заголовок. Экран слайдера смотрит не только тот, кто нажал.
 */
export type DrillPayloadResult
  = | { ok: true, payload: DrillSliderPayload }
    | { ok: false, reason: string }

/** Отказ с причиной — чтобы не повторять форму записи на каждом из десятка выходов. */
function bad(reason: string): DrillPayloadResult {
  return { ok: false, reason }
}

/**
 * Параметры вызова → нагрузка или причина отказа.
 *
 * ⚠ Опасные имена ключей отвергают нагрузку ЦЕЛИКОМ. `__proto__` со строковым значением прошёл
 * бы проверку значения, а присваивание `filter['__proto__'] = 'NEW'` не создаёт своего поля —
 * оно молча ничего не делает. Условие исчезло бы из фильтра, и список оказался бы ШИРЕ числа, по
 * которому нажали, — под верным заголовком. Это ровно тот случай, который замечают на боевых
 * данных и не могут объяснить.
 */
export function readDrillPayload(stored: unknown, nonce: string): DrillPayloadResult {
  let parsed: unknown
  if (typeof stored === 'string') {
    if (!stored.trim()) return bad('условие в user.option пусто')
    try {
      parsed = JSON.parse(stored)
    } catch {
      // Длина важнее текста ошибки: она отличает «обрезано по дороге» от «записан мусор».
      return bad(`условие не разбирается, длина ${stored.length} символов`)
    }
  } else if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    // ⚠ Портал волен отдать запись УЖЕ РАЗОБРАННОЙ: `user.option.get` документирует значение как
    // `object | string | null`, и `savedFilters.ts` — второй читатель того же хранилища — терпит
    // обе формы с самого начала. Прими мы только строку, каждое открытие списка падало бы с
    // «условия нет» — ровно тем симптомом, ради которого этот транспорт и переделан.
    parsed = stored
  } else {
    return bad(`условия в user.option нет (${typeof stored}) — портал не отдал запись или её не успели записать`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bad('условие не объект')
  const handoff = parsed as Record<string, unknown>

  // ⚠ Метка сверяется ДО разбора условия: несовпадение значит «это условие другого нажатия», и
  // показывать его нельзя ни в каком виде. Без сверки слайдер первого клика открыл бы список
  // второго — под своим, первым заголовком.
  if (handoff.nonce !== nonce) {
    return bad('условие устарело: пока слайдер открывался, нажали другое число')
  }
  if (typeof handoff.payload !== 'object' || handoff.payload === null || Array.isArray(handoff.payload)) {
    return bad('в записи нет условия')
  }
  const data = handoff.payload as Record<string, unknown>

  const entity = data.entity
  // ⚠ Тип, а не ЗНАЧЕНИЕ: причина отказа не выносит наружу содержимого записи. `entity` сам по
  // себе безобиден, но копировать этот шаблон в поле с данными CRM нельзя, и образца быть не должно.
  if (entity !== 'lead' && entity !== 'deal' && entity !== 'activity' && entity !== 'call') {
    return bad(`неизвестная сущность (${typeof entity})`)
  }
  const title = typeof data.title === 'string' ? data.title.trim() : ''
  if (!title) return bad('нет заголовка списка')
  if (typeof data.filter !== 'object' || data.filter === null || Array.isArray(data.filter)) return bad('нет условия списка')

  const source = data.filter as Record<string, unknown>
  // ⚠ Потолок на размер: запись возвращается через портал и разбирается как недоверенная, а у
  // недоверенного ввода границы обязаны быть. Числа взяты с запасом: у самого широкого нашего
  // фильтра девять ключей и списки в десятки кодов.
  if (Object.keys(source).length > MAX_FILTER_KEYS) return bad(`в условии ${Object.keys(source).length} полей — больше потолка`)
  const filter: DrillFilter = {}
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(source, key)) continue
    // См. шапку: такой ключ не «пропускаем», а отвергаем всю нагрузку.
    if (UNSAFE_KEYS.has(key)) return bad(`опасное имя поля: ${key}`)
    // Поле не из тех, по которым отчёт строит условия, — нагрузка чужая целиком (см. белый список).
    if (!ALLOWED_FILTER_FIELDS.has(filterField(key))) return bad(`поле условия не разрешено: ${key}`)
    const value = readFilterValue(source[key])
    // Негодное значение — негодная нагрузка целиком: см. шапку про «половину условия».
    if (value === undefined) return bad(`негодное значение условия у поля ${key}`)
    filter[key] = value
  }
  // Пустой фильтр — это «покажи вообще всё»: под заголовком «Сделки: Минск · Иванов» человек
  // увидел бы весь портал. Такое приходит только от подделанного значения, и его отвергаем.
  if (!Object.keys(filter).length) return bad('условие пустое — это «покажи всё», а не список за числом')

  const total = typeof data.total === 'number' && Number.isInteger(data.total) && data.total >= 0
    ? data.total
    : undefined
  const activityScope = data.activityScope === 'created' || data.activityScope === 'overdue'
    ? data.activityScope
    : undefined
  const dealScope = data.dealScope === 'from-leads' || data.dealScope === 'unlinked' || data.dealScope === 'plain'
    ? data.dealScope
    : undefined
  const categoryId = typeof data.categoryId === 'number' && Number.isInteger(data.categoryId) && data.categoryId >= 0
    ? data.categoryId
    : undefined
  const stageNames = readStageNames(data.stageNames)

  return {
    ok: true,
    payload: {
      entity,
      title,
      filter,
      ...(dealScope === undefined ? {} : { dealScope }),
      ...(activityScope === undefined ? {} : { activityScope }),
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(stageNames === undefined ? {} : { stageNames }),
      ...(total === undefined ? {} : { total })
    }
  }
}

/** Годная нагрузка или `undefined`. Тонкая обёртка над `readDrillPayload` — причина не нужна. */
export function decodeDrillPayload(stored: unknown, nonce: string): DrillSliderPayload | undefined {
  const read = readDrillPayload(stored, nonce)
  return read.ok ? read.payload : undefined
}
