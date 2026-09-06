// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportSources from '~/components/ReportSources.vue'
import ReportTopSources from '~/components/ReportTopSources.vue'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'
import { nbsp } from '../helpers/text'

/**
 * Топ-5 — отдельный блок из ТЗ от 2026-09-04. Числа в нём обязаны совпадать с таблицей
 * источников строка в строку: это её первые пять строк, а не пересчёт.
 */
const dataset = buildMockDataset()
const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads' })

function render(overrides: { report?: typeof report } = {}) {
  return mountSuspended(ReportTopSources, {
    props: { report: overrides.report ?? report, dictionaries: dataset.dictionaries, currencyId: dataset.currencyId }
  })
}

describe('ReportTopSources', () => {
  it('не больше пяти строк, по убыванию лидов', async () => {
    const wrapper = await render()
    const rows = wrapper.findAll('tbody tr')
    expect(rows.length).toBeLessThanOrEqual(5)
    expect(rows).toHaveLength(report.topSources.length)
    const leads = rows.map(row => Number(nbsp(row.findAll('td')[1]!.text()).replace(/\s/g, '')))
    expect([...leads].sort((a, b) => b - a)).toEqual(leads)
  })

  it('печатает имена источников и колонки ТЗ', async () => {
    const wrapper = await render()
    const heads = wrapper.findAll('th').map(th => th.text())
    expect(heads).toEqual(['Источник', 'Лиды', 'Брак, %', 'Квалифицировано', 'Конверсия в сделку', 'Успешные', 'Выручка', 'Конверсия в продажу'])
    expect(wrapper.text()).toContain('Входящий звонок')
    expect(wrapper.text()).not.toContain('WEB_FORM')
  })

  it('первая строка — тот же источник и те же числа, что первая строка таблицы источников', async () => {
    const wrapper = await render()
    const first = wrapper.findAll('tbody tr')[0]!.findAll('td').map(td => nbsp(td.text()))
    const top = report.bySource[0]!
    expect(first[0]).toContain('1.')
    expect(first[1]!.replace(/\s/g, '')).toBe(String(top.leads))
    expect(first[5]!.replace(/\s/g, '')).toBe(String(top.won))
  })

  // ⚠ Формат процентов — тоже «число»: 64 % в блоке 5 и 64,3 % здесь читались бы как расхождение.
  it('проценты печатает с той же точностью, что таблица источников', async () => {
    const top = (await render()).findAll('tbody tr')[0]!.findAll('td').map(td => nbsp(td.text()))
    const sources = await mountSuspended(ReportSources, {
      props: { report, dictionaries: dataset.dictionaries, currencyId: dataset.currencyId }
    })
    const full = sources.findAll('tbody tr')[0]!.text()
    // Конверсия в продажу первой строки — одна и та же строка в обеих таблицах.
    expect(nbsp(full)).toContain(top[7]!)
    expect(top[7]).toMatch(/^\d+ %$/)
  })

  it('без лидов говорит об этом словами', async () => {
    const empty = buildReport([], [], { conversionBase: 'quality-leads' })
    expect((await render({ report: empty })).text()).toContain('За период лидов нет')
  })
})
