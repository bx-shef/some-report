// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportSources from '~/components/ReportSources.vue'
import type { ReportDictionaries } from '~/types/report'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'
import { nbsp } from '../helpers/text'

/**
 * Таблица источников — самый плотный числами блок отчёта: восемь колонок, все числовые.
 * Перепутанные местами колонки тайпчекер не поймает, а на глаз это ловится только в браузере.
 */
const dataset = buildMockDataset()

function render(overrides: { report?: ReturnType<typeof buildReport>, dictionaries?: ReportDictionaries } = {}) {
  return mountSuspended(ReportSources, {
    props: {
      report: overrides.report ?? buildReport(dataset.leads, dataset.deals, { conversionBase: 'all-leads' }),
      dictionaries: overrides.dictionaries ?? dataset.dictionaries,
      currencyId: dataset.currencyId
    }
  })
}

describe('ReportSources', () => {
  it('рисует по строке на источник плюс строку итога', async () => {
    const wrapper = await render()
    expect(wrapper.findAll('tbody tr')).toHaveLength(dataset.dictionaries.sources ? 4 : 0)
    expect(wrapper.findAll('tfoot tr')).toHaveLength(1)
  })

  it('печатает имена источников, а не их коды', async () => {
    const text = (await render()).text()
    expect(text).toContain('Входящий звонок')
    expect(text).not.toContain('WEB_FORM')
  })

  it('итог сходится с суммой по колонке «Лиды»', async () => {
    const text = (await render()).findAll('tfoot td').map(td => nbsp(td.text()))
    expect(text[1]).toBe('1 250')
  })

  /**
   * ⚠ Итог таблицы считается по её собственным строкам, а не берётся из сводки: сделки без
   * лида-родителя в разрез источников не входят. Отчёт обязан объяснить расхождение сам.
   */
  it('объясняет выручку, которой нет в таблице', async () => {
    const leads = dataset.leads.slice(0, 10)
    const deals = [
      ...dataset.deals.filter(d => leads.some(l => l.dealIds.includes(d.id))),
      { id: 999_999, sourceId: '', assignedById: 1, outcome: 'won' as const, amount: 7_000 }
    ]
    const report = buildReport(leads, deals, { conversionBase: 'all-leads' })
    const wrapper = await render({ report })
    expect(wrapper.text()).toContain('без лида-родителя')
    expect(nbsp(wrapper.text())).toContain('7 000 BYN')
  })

  /**
   * ⚠ Регрессия, замеченная на скриншоте. Итог печатался с округлением до целого и показывал
   * «50 %» там, где сводка на том же экране показывала «49,6 %». Одно и то же число двумя
   * способами рядом читается как ошибка отчёта, а не как разная точность.
   */
  it('итог по конверсии совпадает со сводкой знак в знак', async () => {
    const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'all-leads' })
    const cells = (await render({ report })).findAll('tfoot td').map(td => nbsp(td.text()))
    // 620 / 1250 = 49,6 % — ровно то, что стоит на плитке «Успешные сделки» в сводке.
    expect(cells).toContain('49,6 %')
    expect(cells).not.toContain('50 %')
  })

  /**
   * Вторая половина того же контраста. Комментарий в компоненте объявляет разную точность
   * осознанным решением; закрепить надо ОБА конца, иначе следующий рефакторинг «выровняет»
   * точность в любую сторону и ни один тест этого не заметит.
   */
  it('строки источников печатают целые проценты, без десятых', async () => {
    const wrapper = await render()
    const rows = wrapper.findAll('tbody td').map(td => nbsp(td.text()))
    const withPercent = rows.filter(t => t.includes('%'))
    expect(withPercent.length).toBeGreaterThan(0)
    expect(withPercent.filter(t => /\d,\d\s*%/.test(t))).toEqual([])
  })

  it('пустой период показывает объяснение вместо пустой таблицы', async () => {
    const report = buildReport([], [], { conversionBase: 'all-leads' })
    expect((await render({ report })).text()).toContain('За период лидов нет')
  })
})
