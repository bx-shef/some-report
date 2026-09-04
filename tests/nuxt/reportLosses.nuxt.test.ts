// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportLosses from '~/components/ReportLosses.vue'
import { formatPercent } from '~/utils/format'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'
import { nbsp } from '../helpers/text'

/**
 * Таблица проигрышей печатает по причине четыре числа (ТЗ): сделок, долю от проигранных, сумму и
 * долю от потерянной суммы. Доли считает ядро; здесь сторожим, что колонка «доля от проигранных»
 * не читает `shareOfLostRevenue` и наоборот — на демо-наборе они близки и глазом не ловятся.
 */
const dataset = buildMockDataset()
const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads' })

function render(overrides: { report?: typeof report } = {}) {
  return mountSuspended(ReportLosses, {
    props: { report: overrides.report ?? report, dictionaries: dataset.dictionaries, currencyId: dataset.currencyId }
  })
}

describe('ReportLosses', () => {
  it('колонки: причина, сделок, доля от проигранных, сумма, доля от потерянной суммы', async () => {
    const heads = (await render()).findAll('th').map(th => th.text())
    expect(heads).toEqual(['Причина проигрыша', 'Сделок', 'Доля от проигранных', 'Сумма потерянных сделок', 'Доля от потерянной суммы'])
  })

  it('каждая строка печатает доли из своего поля ядра', async () => {
    const rows = (await render()).findAll('tbody tr')
    expect(rows).toHaveLength(report.lostDeals.byReason.length)
    rows.forEach((row, i) => {
      const cells = row.findAll('td').map(td => nbsp(td.text()))
      const expected = report.lostDeals.byReason[i]!
      expect(cells[1]!.replace(/\s/g, '')).toBe(String(expected.count))
      expect(cells[2]).toBe(nbsp(formatPercent(expected.shareOfLost, 0)))
      expect(cells[4]).toBe(nbsp(formatPercent(expected.shareOfLostRevenue, 0)))
    })
  })

  it('итог: 100 % в обеих колонках долей', async () => {
    const foot = (await render()).findAll('tfoot td').map(td => nbsp(td.text()))
    expect(foot[2]).toBe('100 %')
    expect(foot[4]).toBe('100 %')
  })

  it('без проигрышей пустая строка растягивается на все пять колонок', async () => {
    const empty = buildReport([], [], { conversionBase: 'quality-leads' })
    const cell = (await render({ report: empty })).find('tbody td')
    expect(cell.attributes('colspan')).toBe('5')
    expect(cell.text()).toContain('За период проигранных сделок нет')
  })
})
