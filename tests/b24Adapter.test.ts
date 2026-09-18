import { describe, expect, it } from 'vitest'
import { statusNames } from '~/utils/b24Adapter'

/**
 * Справочники портала. Разбор строк лидов и сделок проверяется по ЖИВОМУ пути —
 * `adaptLeadCounts` + `adaptDeals` → `buildReportFromAggregate` в `b24Counts.test.ts`, а
 * валюты и приведение значений уехали в свои модули вместе со своими тестами.
 */
describe('statusNames', () => {
  it('строит код → имя', () => {
    expect(statusNames([{ STATUS_ID: 'CALL', NAME: 'Звонок' }])).toEqual({ CALL: 'Звонок' })
  })

  it('элемент без имени остаётся под своим кодом', () => {
    expect(statusNames([{ STATUS_ID: 'UC_X1', NAME: null }])).toEqual({ UC_X1: 'UC_X1' })
  })
})
