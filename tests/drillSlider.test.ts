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
      ['null', null],
      ['вложенная запись', { a: 1 }],
      ['NaN (в JSON приезжает как null)', Number.NaN],
      ['список с посторонним', ['NEW', { a: 1 }]]
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

  // Отрицательное или дробное «всего» — не число записей: подпись «показано 5 из −3» бессмысленна.
  it.each([[-1], [3.5]])('негодное «всего» (%s) просто отбрасывается, нагрузка остаётся годной', (total) => {
    const raw = JSON.stringify({ ...PAYLOAD, total })
    expect(decodeDrillPayload({ [DRILL_PAYLOAD_KEY]: raw })).toEqual({ ...PAYLOAD, total: undefined })
  })
})
