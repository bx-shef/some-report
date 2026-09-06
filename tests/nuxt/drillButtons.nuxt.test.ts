// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { Component } from 'vue'
import ReportFunnel from '~/components/ReportFunnel.vue'
import ReportLosses from '~/components/ReportLosses.vue'
import ReportProcessing from '~/components/ReportProcessing.vue'
import ReportSources from '~/components/ReportSources.vue'
import ReportSummary from '~/components/ReportSummary.vue'
import ReportTopSources from '~/components/ReportTopSources.vue'
import type { DrillRequest } from '~/utils/drilldown'
import { drillListParams } from '~/utils/drilldown'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Кликабельные числа во всех блоках: каждая кнопка отдаёт запрос с самим числом, а запрос
 * собирается в параметры без ошибок. «Источник не указан» — остаток арифметики, не кнопка.
 */
const dataset = buildMockDataset()
// Лид без источника — чтобы в таблице источников появилась строка «не указан».
const leads = [...dataset.leads, { ...dataset.leads[0]!, id: 999_999, sourceId: '' }]
const report = buildReport(leads, dataset.deals, { conversionBase: 'quality-leads', firstResponseSlaMinutes: 120 })
const common = { report, dictionaries: dataset.dictionaries, currencyId: dataset.currencyId }

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const drillButtons = (wrapper: Wrapper) => wrapper.findAll('button').filter((b: { attributes: (name: string) => string | undefined }) => b.attributes('title')?.startsWith('Открыть список'))

describe('кликабельные числа', () => {
  const cases: Array<[string, Component, Record<string, unknown>]> = [
    ['сводка', ReportSummary, { report, currencyId: dataset.currencyId }],
    ['воронка', ReportFunnel, { report, currencyId: dataset.currencyId }],
    ['причины проигрыша', ReportLosses, common],
    ['источники', ReportSources, common],
    ['топ-5', ReportTopSources, common],
    ['обработка', ReportProcessing, { report, dictionaries: dataset.dictionaries }]
  ]

  it.each(cases)('%s: каждая кнопка отдаёт запрос с числом, параметры собираются', async (_name, component, props) => {
    const wrapper = await mountSuspended(component, { props })
    const buttons = drillButtons(wrapper)
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) await button.trigger('click')
    const emitted = wrapper.emitted('drill') ?? []
    expect(emitted).toHaveLength(buttons.length)
    for (const [request] of emitted as DrillRequest[][]) {
      expect(typeof request!.total).toBe('number')
      expect(() => drillListParams(request!, dataset.period, {}, dataset.dictionaries.lossReasonCodes ?? {})).not.toThrow()
    }
  })

  it('источники: строка «не указан» — без единой кнопки, остальные — по четыре', async () => {
    const wrapper = await mountSuspended(ReportSources, { props: common })
    const titles: string[] = drillButtons(wrapper).map((b: { attributes: (name: string) => string | undefined }) => b.attributes('title') ?? '')
    expect(titles.some(t => t.includes('не указан'))).toBe(false)
    const known = Object.keys(dataset.dictionaries.sources).length
    expect(titles).toHaveLength(known * 4)
  })
})
