// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportUnlinkedDeals from '~/components/ReportUnlinkedDeals.vue'
import type { UnlinkedDeals } from '~/types/report'
import { UNKNOWN_SOURCE } from '~/utils/b24Adapter'
import { UNSPECIFIED_SOURCE } from '~/utils/metrics'
import { nbsp } from '../helpers/text'

/**
 * Блок про факт, который отчёт обязан предъявить, а не спрятать: 90 % сделок заводятся мимо
 * лидов. Ошибка в подписи «Источник не указан» → «Другие источники» спрятала бы главную строку.
 */
const dictionaries = { sources: { CALL: 'Звонок' }, junkReasons: {}, lossReasons: {} }

const august: UnlinkedDeals = {
  total: 9191,
  won: 5534,
  shareOfAllDeals: 0.903,
  rows: [
    { sourceId: UNSPECIFIED_SOURCE, count: 8778, share: 0.955, won: 5477 },
    { sourceId: 'CALL', count: 113, share: 0.012, won: 5 },
    { sourceId: UNKNOWN_SOURCE, count: 3, share: 0.0003, won: 0 }
  ]
}

function render(unlinked: UnlinkedDeals = august) {
  return mountSuspended(ReportUnlinkedDeals, { props: { unlinked, dictionaries } })
}

describe('ReportUnlinkedDeals', () => {
  it('печатает итог и долю от всех сделок', async () => {
    const text = nbsp((await render()).text())
    expect(text).toContain('9 191')
    expect(text).toContain('90,3 %')
    expect(text).toContain('5 534')
  })

  it('пустой источник называет прямо, а не «другими источниками»', async () => {
    const text = (await render()).text()
    expect(text).toContain('Источник не указан')
    expect(text).not.toContain('Другие источники')
    expect(text).toContain('Источник вне справочника')
    expect(text).toContain('Звонок')
  })

  it('рисует по строке на источник плюс итог', async () => {
    const wrapper = await render()
    expect(wrapper.findAll('tbody tr')).toHaveLength(3)
    expect(wrapper.findAll('tfoot tr')).toHaveLength(1)
  })

  it('без сделок без лида говорит об этом словами, а не пустой таблицей', async () => {
    const wrapper = await render({ total: 0, won: 0, shareOfAllDeals: 0, rows: [] })
    expect(wrapper.text()).toContain('все сделки связаны с лидами')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})
