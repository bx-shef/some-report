import { describe, expect, it } from 'vitest'
import {
  DRILL_PAYLOAD_KEY,
  DRILL_SLIDER_PLACE,
  MAX_STAGE_NAMES,
  decodeDrillPayload,
  encodeDrillPayload,
  isDrillFrame,
  type DrillSliderPayload
} from '~/utils/drillSlider'

/**
 * Нагрузка страницы детализации, открытой настоящим слайдером портала.
 *
 * ⚠ Проверяем в первую очередь РАЗБОР, а не сборку: обратно значение приезжает от портала, то
 * есть снаружи. Список, собранный по половине условия, покажет НЕ те записи под верным
 * заголовком — а это хуже пустого экрана, потому что выглядит как правда.
 */

const PAYLOAD: DrillSliderPayload = {
  entity: 'deal',
  title: 'Сделки: Минск · Иванов',
  filter: { 'CATEGORY_ID': 0, 'STAGE_ID': 'NEW', 'ASSIGNED_BY_ID': 12, '>=DATE_CREATE': '2026-09-01' },
  total: 27
}

/**
 * Параметры вызова, собранные ВРУЧНУЮ, — чтобы подсунуть разбору то, чего `encodeDrillPayload`
 * никогда не соберёт.
 *
 * ⚠ `place` кладём обязательно: без него фрейм — не детализация вовсе, и разбор отвергнет любую,
 * даже безупречную нагрузку. Пиши тест без `place` — он был бы зелёным по неверной причине.
 */
function options(data: unknown): Record<string, unknown> {
  return { place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: typeof data === 'string' ? data : JSON.stringify(data) }
}

describe('нагрузка слайдера детализации', () => {
  /**
   * ⚠ `place` — заявленный механизм «фрейм узнаёт, что он детализация». Пока он только писался,
   * но не проверялся, любой другой плейсмент со случайным ключом `payload` в своих параметрах
   * нарисовал бы список записей вместо оглавления приложения.
   */
  it('без своего `place` это не детализация, какой бы годной ни была нагрузка', () => {
    expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: JSON.stringify(PAYLOAD) })).toBeUndefined()
    expect(decodeDrillPayload({ place: 'CRM_ANALYTICS_MENU', [DRILL_PAYLOAD_KEY]: JSON.stringify(PAYLOAD) })).toBeUndefined()
    expect(isDrillFrame(encodeDrillPayload(PAYLOAD))).toBe(true)
    expect(isDrillFrame({ place: 'CRM_ANALYTICS_MENU' })).toBe(false)
  })

  /**
   * ⚠ Пустой список — не «условие ни на что»: портал его пропускает, и под заголовком одной
   * причины провала открылся бы весь период. Отчёт таких условий не строит — пустой отбор он
   * решает вовсе без запроса.
   */
  it('пустой список значений отвергает нагрузку', () => {
    expect(decodeDrillPayload(options({ ...PAYLOAD, filter: { STAGE_ID: [] } }))).toBeUndefined()
  })

  /**
   * ⚠ Белый список полей, а не «всё, кроме опасных имён»: наш фрейм открывается по параметру
   * ВЫЗОВА, значит, позвать его может любое приложение портала, а читать CRM оно будет НАШИМ
   * токеном. Полем не из списка чужой фильтр спросил бы то, чего этот отчёт не спрашивает никогда.
   */
  it('поле не из списка полей отчёта отвергает нагрузку, приставки сравнения — нет', () => {
    expect(decodeDrillPayload(options({ ...PAYLOAD, filter: { UF_CRM_SECRET: 'x' } }))).toBeUndefined()
    expect(decodeDrillPayload(options({ ...PAYLOAD, filter: { PHONE: '+375' } }))).toBeUndefined()
    for (const key of ['>=DATE_CREATE', '<DATE_CREATE', '!STATUS_ID', '!LEAD_ID', 'MYCOMPANY_ID']) {
      const decoded = decodeDrillPayload(options({ ...PAYLOAD, filter: { [key]: key === '!LEAD_ID' ? null : '1' } }))
      expect(decoded?.filter).toHaveProperty(key)
    }
  })

  it('собранное читается обратно без потерь', () => {
    const params = encodeDrillPayload(PAYLOAD)
    expect(params.place).toBe(DRILL_SLIDER_PLACE)
    expect(decodeDrillPayload(params)).toEqual(PAYLOAD)
  })

  it('список значений в фильтре переживает дорогу', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, filter: { STAGE_ID: ['NEW', '1'], LEAD_ID: [3, 7] } }
    expect(decodeDrillPayload(encodeDrillPayload(payload))).toEqual(payload)
  })

  it('число, по которому нажали, необязательно', () => {
    const { total: _total, ...without } = PAYLOAD
    expect(decodeDrillPayload(encodeDrillPayload(without))).toEqual(without)
  })

  describe('негодное отвергается целиком', () => {
    const bad: Array<[string, unknown]> = [
      ['ничего не пришло', undefined],
      ['пришла не запись', 'строка'],
      ['параметра нет', { place: DRILL_SLIDER_PLACE }],
      ['параметр пуст', { [DRILL_PAYLOAD_KEY]: '  ' }],
      ['не JSON', { [DRILL_PAYLOAD_KEY]: '{' }],
      ['JSON, но массив', { [DRILL_PAYLOAD_KEY]: '[1,2]' }],
      ['чужая сущность', options({ ...PAYLOAD, entity: 'company' })],
      ['заголовок пуст', options({ ...PAYLOAD, title: '   ' })],
      ['фильтра нет', options({ entity: 'lead', title: 'Лиды' })],
      ['фильтр — массив', options({ ...PAYLOAD, filter: ['NEW'] })]
    ]
    it.each(bad)('%s', (_name, options) => {
      expect(decodeDrillPayload(options)).toBeUndefined()
    })

    /**
     * ⚠ Пустой фильтр — это «покажи вообще всё». Под заголовком «Сделки: Минск · Иванов» человек
     * увидел бы весь портал и поверил бы, потому что заголовок верный.
     */
    it('пустой фильтр — не «без условия», а негодная нагрузка', () => {
      expect(decodeDrillPayload(options({ ...PAYLOAD, filter: {} }))).toBeUndefined()
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
      expect(decodeDrillPayload(options(raw))).toBeUndefined()
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
      expect(decodeDrillPayload(options(raw))).toBeUndefined()
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
    expect(decodeDrillPayload(encodeDrillPayload(payload))).toEqual(payload)
  })

  it('охват сделок и направление переживают дорогу', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, dealScope: 'unlinked', categoryId: 3 }
    expect(decodeDrillPayload(encodeDrillPayload(payload))).toEqual(payload)
  })

  /**
   * ⚠ Потолок нужен потому, что нагрузка едет через портал: усечённый по дороге JSON разбор
   * отвергнет и так, но огромный ЦЕЛЫЙ фильтр лучше не отправлять вовсе.
   */
  it('слишком широкая нагрузка отвергается', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`F${i}`, 'x']))
    expect(decodeDrillPayload(options({ ...PAYLOAD, filter: many }))).toBeUndefined()
    const longList = { ...PAYLOAD, filter: { ID: Array.from({ length: 1001 }, (_, i) => i) } }
    expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: JSON.stringify(longList) })).toBeUndefined()
  })

  /**
   * ⚠ Подписи стадий — то немногое, что нагрузка НЕ обязана иметь и из-за чего не отвергается:
   * подпись косметика, условие — нет. Отказ открыть список из-за кривой подписи оставил бы
   * человека вовсе без данных там, где хватило бы кода стадии.
   */
  it('подписи стадий переживают дорогу, а негодные не губят нагрузку', () => {
    const payload: DrillSliderPayload = { ...PAYLOAD, stageNames: { 'C4:APOLOGY': 'Отказ - Дорого' } }
    expect(decodeDrillPayload(encodeDrillPayload(payload))).toEqual(payload)

    for (const bad of [{}, 'строка', ['C4:APOLOGY']]) {
      const decoded = decodeDrillPayload(options({ ...PAYLOAD, stageNames: bad }))
      expect(decoded?.filter).toEqual(PAYLOAD.filter)
      expect(decoded?.stageNames).toBeUndefined()
    }
  })

  /**
   * ⚠ Лишние подписи ОБРЕЗАЮТСЯ, а не отвергаются все. Отвергнув, мы получили бы худший исход:
   * список, где не хватало бы нескольких подписей, потерял бы вместо этого ВСЕ и показал бы
   * пятнадцать `C4:APOLOGY` под заголовком «Отказ - Дорого».
   */
  it('подписей больше потолка — лишние обрезаются, остальные остаются', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_STAGE_NAMES + 10 }, (_, i) => [`S${i}`, `Причина ${i}`]))
    const decoded = decodeDrillPayload(options({ ...PAYLOAD, stageNames: many }))
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
    expect(decodeDrillPayload(options(raw))?.stageNames).toEqual({ 'C4:APOLOGY': 'Отказ - Дорого' })
  })

  it('опасное имя `prototype` тоже отвергает нагрузку', () => {
    const raw = '{"entity":"lead","title":"Лиды","filter":{"prototype":"NEW","STATUS_ID":"NEW"}}'
    expect(decodeDrillPayload(options(raw))).toBeUndefined()
  })

  it.each([
    ['поля entity нет вовсе', { title: 'Лиды', filter: { STATUS_ID: 'NEW' } }],
    ['всего строкой', { ...PAYLOAD, total: '27' }]
  ])('%s', (_name, data) => {
    const decoded = decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: JSON.stringify(data) })
    // Негодная сущность губит нагрузку, негодное «всего» — только само себя.
    expect(decoded === undefined || decoded.total === undefined).toBe(true)
  })

  // Отрицательное или дробное «всего» — не число записей: подпись «показано 5 из −3» бессмысленна.
  it.each([[-1], [3.5]])('негодное «всего» (%s) просто отбрасывается, нагрузка остаётся годной', (total) => {
    const raw = JSON.stringify({ ...PAYLOAD, total })
    expect(decodeDrillPayload(options(raw))).toEqual({ ...PAYLOAD, total: undefined })
  })
})
