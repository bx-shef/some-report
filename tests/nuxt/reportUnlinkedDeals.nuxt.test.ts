// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportUnlinkedDeals from '~/components/ReportUnlinkedDeals.vue'
import type { UnlinkedDeals } from '~/types/report'
import { UNSPECIFIED_SOURCE } from '~/utils/metrics'
import { nbsp } from '../helpers/text'

/**
 * Блок про факт, который отчёт обязан предъявить, а не спрятать: 90 % сделок заводятся мимо
 * лидов. Колонки «сделок» и «успешных» — числа-тёзки: перепутанные местами их не поймает ни
 * тайпчекер, ни проверка по сплошному тексту. Поэтому проверяем ячейки, а не текст карточки.
 */
const dictionaries = { sources: { CALL: 'Звонок' }, junkReasons: {}, lossReasons: {} }

const august: UnlinkedDeals = {
  total: 9191,
  won: 5536,
  shareOfAllDeals: 0.903,
  rows: [
    { sourceId: UNSPECIFIED_SOURCE, count: 9078, share: 0.988, won: 5531 },
    { sourceId: 'CALL', count: 113, share: 0.012, won: 5 }
  ]
}

function render(unlinked: UnlinkedDeals = august) {
  return mountSuspended(ReportUnlinkedDeals, { props: { unlinked, dictionaries } })
}

describe('ReportUnlinkedDeals', () => {
  it('печатает итог и долю от всех сделок в шапке', async () => {
    const text = nbsp((await render()).text())
    expect(text).toContain('9 191')
    expect(text).toContain('90,3 %')
    expect(text).toContain('5 536')
  })

  it('остаток называет прямо, а не «другими источниками»', async () => {
    const text = (await render()).text()
    expect(text).toContain('Источник не указан')
    expect(text).not.toContain('Другие источники')
    expect(text).toContain('Звонок')
  })

  it('числа стоят в своих колонках: сделок, доля, успешных', async () => {
    const wrapper = await render()
    const first = wrapper.findAll('tbody tr')[0]!.findAll('td').map(td => nbsp(td.text()))
    expect(first[0]).toContain('Источник не указан')
    expect(first[1]).toBe('9 078')
    expect(first[2]).toContain('%')
    expect(first[3]).toBe('5 531')
    const foot = wrapper.find('tfoot').findAll('td').map(td => nbsp(td.text()))
    expect(foot[1]).toBe('9 191')
    expect(foot[3]).toBe('5 536')
  })

  it('рисует по строке на источник плюс итог', async () => {
    const wrapper = await render()
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    expect(wrapper.findAll('tfoot tr')).toHaveLength(1)
  })

  it('без сделок без лида говорит об этом словами, а не пустой таблицей', async () => {
    const wrapper = await render({ total: 0, won: 0, shareOfAllDeals: 0, rows: [] })
    expect(wrapper.text()).toContain('все сделки связаны с лидами')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})
