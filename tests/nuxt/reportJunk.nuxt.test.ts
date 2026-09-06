// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportJunk from '~/components/ReportJunk.vue'
import { formatPercent } from '~/utils/format'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'
import { nbsp } from '../helpers/text'

/**
 * Таблица брака печатает ДВЕ доли — от всех лидов и от брака (ТЗ). Ядро считает обе и покрыто
 * юнитом; здесь сторожим привязку колонок к полям: перепутанные местами `shareOfLeads` и
 * `shareOfJunk` тайпчекер не поймает, а 7 % и 36 % оба выглядят правдоподобно.
 */
const dataset = buildMockDataset()
const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads' })

function render(overrides: { report?: typeof report } = {}) {
  return mountSuspended(ReportJunk, { props: { report: overrides.report ?? report, dictionaries: dataset.dictionaries } })
}

describe('ReportJunk', () => {
  it('колонки: причина, количество, доля от лидов, доля от брака', async () => {
    const heads = (await render()).findAll('th').map(th => th.text())
    expect(heads).toEqual(['Причина брака', 'Количество лидов', 'Доля от лидов', 'Доля от брака'])
  })

  it('каждая строка печатает доли из своего поля ядра', async () => {
    const rows = (await render()).findAll('tbody tr')
    expect(rows).toHaveLength(report.junkByReason.length)
    rows.forEach((row, i) => {
      const cells = row.findAll('td').map(td => nbsp(td.text()))
      const expected = report.junkByReason[i]!
      expect(cells[1]!.replace(/\s/g, '')).toBe(String(expected.count))
      expect(cells[2]).toBe(nbsp(formatPercent(expected.shareOfLeads)))
      expect(cells[3]).toBe(nbsp(formatPercent(expected.shareOfJunk, 0)))
    })
  })

  it('итог: доля брака от лидов и 100 % от брака', async () => {
    const foot = (await render()).findAll('tfoot td').map(td => nbsp(td.text()))
    expect(foot[2]).toBe(nbsp(formatPercent(report.summary.junkShare)))
    expect(foot[3]).toBe('100 %')
  })

  it('без брака пустая строка растягивается на все четыре колонки', async () => {
    const empty = buildReport([], [], { conversionBase: 'quality-leads' })
    const cell = (await render({ report: empty })).find('tbody td')
    expect(cell.attributes('colspan')).toBe('4')
    expect(cell.text()).toContain('За период брака нет')
  })

  // Число причины — кнопка списка «тем же условием»: стадия брака этой причины.
  it('клик по числу причины — событие drill со стадией этой причины; итог брака — с семантикой провала', async () => {
    const wrapper = await render()
    const [row] = report.junkByReason
    const button = wrapper.findAll('button').find((b: { attributes: (name: string) => string | undefined }) => b.attributes('title')?.startsWith('Открыть список: Брак лидов:'))!
    await button.trigger('click')
    expect(wrapper.emitted('drill')?.[0]?.[0]).toMatchObject({ entity: 'lead', extra: { STATUS_ID: row!.reasonId } })
    const total = wrapper.findAll('button').find((b: { attributes: (name: string) => string | undefined }) => b.attributes('title') === 'Открыть список: Брак лидов')!
    await total.trigger('click')
    expect(wrapper.emitted('drill')?.[1]?.[0]).toMatchObject({ extra: { STATUS_SEMANTIC_ID: 'F' } })
  })
})
