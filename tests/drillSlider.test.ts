import { describe, expect, it } from 'vitest'
import {
  DRILL_PAYLOAD_KEY,
  DRILL_SLIDER_PLACE,
  MAX_STAGE_NAMES,
  decodeDrillPayload,
  drillNonceFrom,
  encodeDrillCall,
  encodeDrillHandoff,
  isDrillFrame,
  newDrillNonce,
  parsePlacementOptions,
  readDrillPayload,
  type DrillSliderPayload
} from '~/utils/drillSlider'

/**
 * Передача условия в слайдер детализации.
 *
 * ⚠ Условие едет НЕ параметрами вызова: `PLACEMENT_OPTIONS` килобайтов не держит — на боевом
 * портале короткий `place` доехал, а JSON фильтра нет, и человек увидел «Список не открылся» при
 * исправном отчёте. Теперь параметрами едет короткий одноразовый ключ, а условие — записью в
 * `user.option` портала.
 *
 * ⚠ Проверяем в первую очередь РАЗБОР, а не сборку: запись возвращается через портал, то есть
 * снаружи. Список, собранный по половине условия, покажет НЕ те записи под верным заголовком — а
 * это хуже пустого экрана, потому что выглядит как правда.
 */

const PAYLOAD: DrillSliderPayload = {
  entity: 'deal',
  title: 'Сделки: Минск · Иванов',
  filter: { 'CATEGORY_ID': 0, 'STAGE_ID': 'NEW', 'ASSIGNED_BY_ID': 12, '>=DATE_CREATE': '2026-09-01' },
  total: 27
}

/** Метка условия: одна на файл — здесь проверяется разбор, а не одноразовость. */
const NONCE = 'ключ-теста'

/**
 * Запись `user.option`, собранная ВРУЧНУЮ, — чтобы подсунуть разбору то, чего
 * `encodeDrillHandoff` никогда не соберёт. Строку кладём как есть: ею подсовывают битый JSON.
 *
 * ⚠ Метку ставим обязательно: без совпадения меток разбор отвергнет любую, даже безупречную
 * нагрузку — это условие ДРУГОГО нажатия. Тест без метки был бы зелёным по неверной причине.
 */
function stored(data: unknown): string {
  return `{"nonce":${JSON.stringify(NONCE)},"payload":${typeof data === 'string' ? data : JSON.stringify(data)}}`
}

/** Разбор записи с правильной меткой — то, что делает открывшийся слайдер. */
function decode(value: unknown) {
  return decodeDrillPayload(value, NONCE)
}

describe('нагрузка слайдера детализации', () => {
  /**
   * ⚠ В параметрах вызова — только место и КОРОТКИЙ ключ. Это выученный урок: килобайтный JSON
   * этот канал не донёс, а короткий скаляр донёс.
   */
  it('в параметрах вызова нет ничего, кроме места и ключа', () => {
    const params = encodeDrillCall(NONCE)
    expect(params.place).toBe(DRILL_SLIDER_PLACE)
    expect(params[DRILL_PAYLOAD_KEY]).toBe(NONCE)
    expect(Object.keys(params)).toHaveLength(2)
    expect(JSON.stringify(params)).not.toContain('NEW')
  })

  /**
   * ⚠ `PLACEMENT_OPTIONS` приходит объектом ЛИБО JSON-строкой: SDK кладёт их как есть
   * (`placement.mjs`), а регистр ключей задаёт портал — остальные поля он шлёт заглавными
   * (`PLACEMENT`, `LANG`, `IS_ADMIN`). Наивное чтение молча даёт «фрейм не детализация», и
   * человек, нажавший на число, получает оглавление приложения.
   */
  it.each([
    ['объектом', { place: DRILL_SLIDER_PLACE, drill: NONCE }],
    ['JSON-строкой', JSON.stringify({ place: DRILL_SLIDER_PLACE, drill: NONCE })],
    ['заглавными ключами', { PLACE: DRILL_SLIDER_PLACE, DRILL: NONCE }]
  ])('ключ читается, когда параметры пришли %s', (_name, options) => {
    expect(drillNonceFrom(options)).toBe(NONCE)
    expect(isDrillFrame(options)).toBe(true)
  })

  /**
   * ⚠ Второй источник — строка запроса, и он не «на всякий случай»: у `client-bank-alfa-by`
   * живой портал прислал фрейму слайдера ПУСТОЙ `PLACEMENT_OPTIONS`, и параметр приехал адресом.
   */
  it('ключ читается из адреса, когда параметров вызова нет вовсе', () => {
    expect(drillNonceFrom({}, `?bx24_${DRILL_PAYLOAD_KEY}=${NONCE}`)).toBe(NONCE)
    expect(drillNonceFrom(undefined, `?${DRILL_PAYLOAD_KEY}=${NONCE}`)).toBe(NONCE)
    expect(drillNonceFrom({}, '?preview=1')).toBeUndefined()
  })

  it('чужие параметры вызова — не детализация', () => {
    expect(isDrillFrame({ place: 'CRM_ANALYTICS_MENU' })).toBe(false)
    expect(parsePlacementOptions('не json')).toEqual({})
  })

  /**
   * ⚠ Метка одноразовая: нажали два числа подряд — второе перезаписало условие. Слайдер первого
   * обязан отвергнуть чужое условие, а не показать его под своим заголовком.
   */
  it('условие другого нажатия не читается', () => {
    expect(decodeDrillPayload(encodeDrillHandoff('ключ-другой', PAYLOAD), NONCE)).toBeUndefined()
  })

  /**
   * ⚠ Пустой список — не «условие ни на что»: портал его пропускает, и под заголовком одной
   * причины провала открылся бы весь период. Отчёт таких условий не строит — пустой отбор он
   * решает вовсе без запроса.
   */
  it('пустой список значений отвергает нагрузку', () => {
    expect(decode(stored({ ...PAYLOAD, filter: { STAGE_ID: [] } }))).toBeUndefined()
  })

  /**
   * ⚠ Белый список полей, а не «всё, кроме опасных имён»: наш фрейм открывается по параметру
   * ВЫЗОВА, значит, позвать его может любое приложение портала, а читать CRM оно будет НАШИМ
   * токеном. Полем не из списка чужой фильтр спросил бы то, чего этот отчёт не спрашивает никогда.
   */
  it('поле не из списка полей отчёта отвергает нагрузку, приставки сравнения — нет', () => {
    expect(decode(stored({ ...PAYLOAD, filter: { UF_CRM_SECRET: 'x' } }))).toBeUndefined()
    expect(decode(stored({ ...PAYLOAD, filter: { PHONE: '+375' } }))).toBeUndefined()
    for (const key of ['>=DATE_CREATE', '<DATE_CREATE', '!STATUS_ID', '!LEAD_ID', 'MYCOMPANY_ID']) {
      const decoded = decode(stored({ ...PAYLOAD, filter: { [key]: key === '!LEAD_ID' ? null : '1' } }))
      expect(decoded?.filter).toHaveProperty(key)
    }
  })

  /**
   * ⚠ Ключ различает «моё условие» и «условие соседнего нажатия», а не охраняет доступ — доступ
   * охраняет авторизация портала: `user.option` привязан к паре «наше приложение + этот человек».
   * Поэтому от ключа нужна неповторяемость в пределах пары кликов, а не стойкость к подбору. Но
   * ЗАПАСНОЙ путь без `crypto` обязан работать: без него `openDrill` падал бы там, где нет
   * защищённого контекста, — то есть нигде в тестах и вдруг на чьём-то устройстве.
   */
  it('ключ неповторяем и собирается даже без crypto', () => {
    expect(new Set(Array.from({ length: 50 }, () => newDrillNonce())).size).toBe(50)
    const crypto = globalThis.crypto
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
      const fallback = Array.from({ length: 50 }, () => newDrillNonce())
      expect(fallback.every(value => value.length > 8)).toBe(true)
      expect(new Set(fallback).size).toBe(50)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: crypto, configurable: true })
    }
  })

  /**
   * ⚠ Запись возвращается из портала объектом ЛИБО строкой: `user.option.get` документирует
   * значение как `object | string | null`, и `savedFilters.ts` — второй читатель того же
   * хранилища — терпит обе формы. Прими мы только строку, каждое открытие списка падало бы с
   * «условия нет» — тем самым симптомом, ради которого транспорт и переделан.
   */
  it('условие читается и объектом, и строкой', () => {
    expect(decode({ nonce: NONCE, payload: PAYLOAD })).toEqual(PAYLOAD)
    expect(decode(encodeDrillHandoff(NONCE, PAYLOAD))).toEqual(PAYLOAD)
  })

  it('собранное читается обратно без потерь', () => {
    expect(decode(encodeDrillHandoff(NONCE, PAYLOAD))).toEqual(PAYLOAD)
  })

  it('список значений в фильтре переживает дорогу', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, filter: { STAGE_ID: ['NEW', '1'], LEAD_ID: [3, 7] } }
    expect(decode(encodeDrillHandoff(NONCE, payload))).toEqual(payload)
  })

  it('число, по которому нажали, необязательно', () => {
    const { total: _total, ...without } = PAYLOAD
    expect(decode(encodeDrillHandoff(NONCE, without))).toEqual(without)
  })

  describe('негодное отвергается целиком', () => {
    const bad: Array<[string, unknown]> = [
      ['ничего не пришло', undefined],
      ['записи нет строкой', 42],
      ['запись пуста', '  '],
      ['не JSON', '{'],
      ['JSON, но массив', '[1,2]'],
      ['в записи нет условия', JSON.stringify({ nonce: NONCE })],
      ['чужая сущность', stored({ ...PAYLOAD, entity: 'company' })],
      ['заголовок пуст', stored({ ...PAYLOAD, title: '   ' })],
      ['фильтра нет', stored({ entity: 'lead', title: 'Лиды' })],
      ['фильтр — массив', stored({ ...PAYLOAD, filter: ['NEW'] })]
    ]
    it.each(bad)('%s', (_name, value) => {
      expect(decode(value)).toBeUndefined()
    })

    /**
     * ⚠ Пустой фильтр — это «покажи вообще всё». Под заголовком «Сделки: Минск · Иванов» человек
     * увидел бы весь портал и поверил бы, потому что заголовок верный.
     */
    it('пустой фильтр — не «без условия», а негодная нагрузка', () => {
      expect(decode(stored({ ...PAYLOAD, filter: {} }))).toBeUndefined()
    })

    /**
     * ⚠ Одно негодное значение делает негодной всю нагрузку. Отбросив его молча, мы показали бы
     * список ШИРЕ запрошенного — записи, которых за нажатым числом нет.
     */
    it.each([
      ['булево', true],
      ['вложенная запись', { a: 1 }],
      ['список с посторонним', ['NEW', { a: 1 }]],
      ['список списков', [['NEW']]]
    ])('значение фильтра «%s» отвергает нагрузку целиком', (_name, value) => {
      const raw = JSON.stringify({ ...PAYLOAD, filter: { ...PAYLOAD.filter, STAGE_ID: value } })
      expect(decode(stored(raw))).toBeUndefined()
    })

    /**
     * ⚠ Опасное имя ключа отвергает нагрузку ЦЕЛИКОМ, а не пропускается.
     *
     * Со СТРОКОВЫМ значением `__proto__` прошёл бы проверку значения, а присваивание
     * `filter['__proto__'] = 'NEW'` не создаёт своего поля — оно молча ничего не делает. Условие
     * исчезло бы из фильтра, и список оказался бы ШИРЕ числа, по которому нажали, под верным
     * заголовком. Проверяем оба варианта: и объектом, и строкой.
     */
    it.each([
      ['объектом', '{"__proto__":{"polluted":true},"STATUS_ID":"NEW"}'],
      ['строкой', '{"__proto__":"NEW","STATUS_ID":"NEW"}'],
      ['constructor', '{"constructor":"NEW","STATUS_ID":"NEW"}']
    ])('опасный ключ фильтра (%s) отвергает нагрузку', (_name, filter) => {
      const raw = `{"entity":"lead","title":"Лиды","filter":${filter}}`
      expect(decode(stored(raw))).toBeUndefined()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
  })

  /**
   * ⚠ `null` — ЗНАЧИМОЕ условие REST, а не «значения нет». Отчёт по лидам берёт сделки условием
   * `'!LEAD_ID': null` («у сделки есть лид»). Отвергни его разбор — и все списки сделок этого
   * отчёта открывали бы пустой слайдер при совершенно исправном отчёте. Ровно этот дефект и
   * нашли ревью: `NaN` в JSON тоже приезжает как `null`, и соблазн «отвергать null» велик.
   */
  it('null в фильтре — годное условие, а не мусор', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, filter: { '!LEAD_ID': null, 'CATEGORY_ID': 0 } }
    expect(decode(encodeDrillHandoff(NONCE, payload))).toEqual(payload)
  })

  it('охват сделок и направление переживают дорогу', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, dealScope: 'unlinked', categoryId: 3 }
    expect(decode(encodeDrillHandoff(NONCE, payload))).toEqual(payload)
  })

  /**
   * ⚠ Потолок нужен потому, что нагрузка едет через портал: усечённый по дороге JSON разбор
   * отвергнет и так, но огромный ЦЕЛЫЙ фильтр лучше не отправлять вовсе.
   */
  it('слишком широкая нагрузка отвергается', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`F${i}`, 'x']))
    expect(decode(stored({ ...PAYLOAD, filter: many }))).toBeUndefined()
    const longList = { ...PAYLOAD, filter: { ID: Array.from({ length: 1001 }, (_, i) => i) } }
    expect(decode(stored(longList))).toBeUndefined()
  })

  /**
   * ⚠ Подписи стадий — то немногое, что нагрузка НЕ обязана иметь и из-за чего не отвергается:
   * подпись косметика, условие — нет. Отказ открыть список из-за кривой подписи оставил бы
   * человека вовсе без данных там, где хватило бы кода стадии.
   */
  it('подписи стадий переживают дорогу, а негодные не губят нагрузку', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, stageNames: { 'C4:APOLOGY': 'Отказ - Дорого' } }
    expect(decode(encodeDrillHandoff(NONCE, payload))).toEqual(payload)

    for (const bad of [{}, 'строка', ['C4:APOLOGY']]) {
      const decoded = decode(stored({ ...PAYLOAD, stageNames: bad }))
      expect(decoded?.filter).toEqual(PAYLOAD.filter)
      expect(decoded?.stageNames).toBeUndefined()
    }
  })

  /**
   * ⛔ Название источника едет ОДНОЙ строкой на весь список, потому что список и собран из сделок
   * одного источника — по источнику ЛИДА. Без него колонка «Источник» печатала бы собственное
   * поле сделки, а у «Заказа покупателя» из 1С его нет вовсе.
   *
   * ⚠ Приходит оно СНАРУЖИ, поэтому режется по длине: строка без границы распухла бы в шапку
   * списка. И, как подписи стадий, негодное значение нагрузку не отвергает — это косметика.
   */
  it('название источника переживает дорогу, режется по длине и не губит нагрузку', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, sourceName: 'Входящий звонок' }
    expect(decode(encodeDrillHandoff(NONCE, payload))).toEqual(payload)

    for (const bad of [42, '', '   ', {}, ['Звонок']]) {
      const decoded = decode(stored({ ...PAYLOAD, sourceName: bad }))
      expect(decoded?.filter).toEqual(PAYLOAD.filter)
      expect(decoded?.sourceName).toBeUndefined()
    }

    const long = decode(stored({ ...PAYLOAD, sourceName: 'я'.repeat(500) }))
    expect(long?.sourceName).toHaveLength(200)
  })

  /**
   * ⚠ Лишние подписи ОБРЕЗАЮТСЯ, а не отвергаются все. Отвергнув, мы получили бы худший исход:
   * список, где не хватало бы нескольких подписей, потерял бы вместо этого ВСЕ и показал бы
   * пятнадцать `C4:APOLOGY` под заголовком «Отказ - Дорого».
   */
  it('подписей больше потолка — лишние обрезаются, остальные остаются', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_STAGE_NAMES + 10 }, (_, i) => [`S${i}`, `Причина ${i}`]))
    const decoded = decode(stored({ ...PAYLOAD, stageNames: many }))
    expect(Object.keys(decoded?.stageNames ?? {})).toHaveLength(MAX_STAGE_NAMES)
    expect(decoded?.stageNames?.S0).toBe('Причина 0')
  })

  /**
   * Опасный ключ в подписях — не «отвергнуть всё»: выкидываем его, остальные подписи остаются.
   *
   * ⚠ JSON здесь написан строкой, а не собран `JSON.stringify` из литерала: в литерале ключ
   * `__proto__` СВОЕГО поля не создаёт — он назначает прототип, и строку в нём молча
   * игнорируют. Такая проверка была бы зелёной при выброшенном условии.
   */
  it('опасное имя в подписях выкидывает только его', () => {
    const raw = '{"entity":"deal","title":"Сделки","filter":{"STAGE_ID":"C4:APOLOGY"},'
      + '"stageNames":{"__proto__":"Взлом","C4:APOLOGY":"Отказ - Дорого"}}'
    // Сторож самой проверки: у разобранного JSON опасный ключ — СВОЙ, значит, его есть что выкидывать.
    expect(Object.keys(JSON.parse(raw).stageNames)).toContain('__proto__')
    expect(decode(stored(raw))?.stageNames).toEqual({ 'C4:APOLOGY': 'Отказ - Дорого' })
  })

  it('опасное имя `prototype` тоже отвергает нагрузку', () => {
    const raw = '{"entity":"lead","title":"Лиды","filter":{"prototype":"NEW","STATUS_ID":"NEW"}}'
    expect(decode(stored(raw))).toBeUndefined()
  })

  it.each([
    ['поля entity нет вовсе', { title: 'Лиды', filter: { STATUS_ID: 'NEW' } }],
    ['всего строкой', { ...PAYLOAD, total: '27' }]
  ])('%s', (_name, data) => {
    const decoded = decode(stored(data))
    // Негодная сущность губит нагрузку, негодное «всего» — только само себя.
    expect(decoded === undefined || decoded.total === undefined).toBe(true)
  })

  // Отрицательное или дробное «всего» — не число записей: подпись «показано 5 из −3» бессмысленна.
  it.each([[-1], [3.5]])('негодное «всего» (%s) просто отбрасывается, нагрузка остаётся годной', (total) => {
    const raw = JSON.stringify({ ...PAYLOAD, total })
    expect(decode(stored(raw))).toEqual({ ...PAYLOAD, total: undefined })
  })
})

describe('нагрузка отчёта «Активность пользователей»', () => {
  function handoff(payload: Record<string, unknown>): string {
    return JSON.stringify({ nonce: 'n1', payload })
  }

  const CALLS = {
    entity: 'call',
    title: 'Разговоры · Иванов',
    filter: { 'PORTAL_USER_ID': 7, 'CALL_FAILED_CODE': '200', '>CALL_DURATION': 29 }
  }

  it('сущности дел и звонков разбираются', () => {
    const call = readDrillPayload(handoff(CALLS), 'n1')
    expect(call.ok && call.payload.entity).toBe('call')
    const deed = readDrillPayload(handoff({
      entity: 'activity', title: 'Письма', filter: { RESPONSIBLE_ID: 7, TYPE_ID: 4 }
    }), 'n1')
    expect(deed.ok && deed.payload.entity).toBe('activity')
  })

  /**
   * ⛔ Позвать наш фрейм может ЛЮБОЕ приложение портала, а читать CRM оно будет НАШИМ токеном.
   * Поля, которых отчёт не спрашивает никогда, обязаны отвергать нагрузку ЦЕЛИКОМ — иначе чужой
   * фильтр спросил бы то, чего мы не спрашиваем.
   */
  it.each(['SUBJECT', 'PHONE_NUMBER', 'OWNER_ID', 'CALL_RECORD_URL', 'UF_CRM_SECRET'])(
    'поле %s вне белого списка отвергает нагрузку целиком',
    (field) => {
      const bad = readDrillPayload(handoff({ ...CALLS, filter: { ...CALLS.filter, [field]: 1 } }), 'n1')
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.reason).toContain(field)
    }
  )

  /** ⚠ Охваты — из закрытого списка: мусорное значение становится `undefined`, а не ломает разбор. */
  it('охваты дела и лида проверяются по значению', () => {
    const good = readDrillPayload(handoff({ ...CALLS, entity: 'lead', filter: { ASSIGNED_BY_ID: 7 }, leadScope: 'closed' }), 'n1')
    expect(good.ok && good.payload.leadScope).toBe('closed')
    const junk = readDrillPayload(handoff({ ...CALLS, entity: 'lead', filter: { ASSIGNED_BY_ID: 7 }, leadScope: 'вчера' }), 'n1')
    expect(junk.ok && junk.payload.leadScope).toBeUndefined()
    const deed = readDrillPayload(handoff({ entity: 'activity', title: 'Просрочка', filter: { RESPONSIBLE_ID: 7 }, activityScope: 'overdue' }), 'n1')
    expect(deed.ok && deed.payload.activityScope).toBe('overdue')
  })
})
