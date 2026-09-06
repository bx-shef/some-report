import { describe, expect, it } from 'vitest'
import {
  DRILL_PAYLOAD_KEY,
  DRILL_SLIDER_PLACE,
  decodeDrillPayload,
  encodeDrillPayload,
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

describe('нагрузка слайдера детализации', () => {
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
      ['чужая сущность', { [DRILL_PAYLOAD_KEY]: JSON.stringify({ ...PAYLOAD, entity: 'company' }) }],
      ['заголовок пуст', { [DRILL_PAYLOAD_KEY]: JSON.stringify({ ...PAYLOAD, title: '   ' }) }],
      ['фильтра нет', { [DRILL_PAYLOAD_KEY]: JSON.stringify({ entity: 'lead', title: 'Лиды' }) }],
      ['фильтр — массив', { [DRILL_PAYLOAD_KEY]: JSON.stringify({ ...PAYLOAD, filter: ['NEW'] }) }]
    ]
    it.each(bad)('%s', (_name, options) => {
      expect(decodeDrillPayload(options)).toBeUndefined()
    })

    /**
     * ⚠ Пустой фильтр — это «покажи вообще всё». Под заголовком «Сделки: Минск · Иванов» человек
     * увидел бы весь портал и поверил бы, потому что заголовок верный.
     */
    it('пустой фильтр — не «без условия», а негодная нагрузка', () => {
      expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: JSON.stringify({ ...PAYLOAD, filter: {} }) })).toBeUndefined()
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
      expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: raw })).toBeUndefined()
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
      expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: raw })).toBeUndefined()
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
    expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: JSON.stringify({ ...PAYLOAD, filter: many }) })).toBeUndefined()
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

    for (const bad of [{}, 'строка', ['C4:APOLOGY'], Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`S${i}`, 'x']))]) {
      const decoded = decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: JSON.stringify({ ...PAYLOAD, stageNames: bad }) })
      expect(decoded?.filter).toEqual(PAYLOAD.filter)
      expect(decoded?.stageNames).toBeUndefined()
    }
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
    expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: raw })?.stageNames).toEqual({ 'C4:APOLOGY': 'Отказ - Дорого' })
  })

  it('опасное имя `prototype` тоже отвергает нагрузку', () => {
    const raw = '{"entity":"lead","title":"Лиды","filter":{"prototype":"NEW","STATUS_ID":"NEW"}}'
    expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: raw })).toBeUndefined()
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
    expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: raw })).toEqual({ ...PAYLOAD, total: undefined })
  })
})
