// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportProcessing from '~/components/ReportProcessing.vue'
import type { ReportMetrics } from '~/types/report'
import { buildReport, processingFromCounts } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Блок 6 в трёх состояниях портала: счётчики уже есть, а история стадий идёт / ждёт кнопки /
 * упала. Прочерк вместо нуля там, где времени ещё нет, — не косметика: «просрочено 0» читалось
 * бы как факт о работе отдела.
 */
const dataset = buildMockDataset()
const full = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads', firstResponseSlaMinutes: 120 })

/** Отчёт по счётчикам: обработано есть, времени нет, открытые лиды по стадиям — есть. */
const counted: ReportMetrics = {
  ...full,
  processing: processingFromCounts(100, 4),
  preDealLoss: { ...full.preDealLoss, byStage: [{ stageId: '1', count: 30 }, { stageId: 'NEW', count: 4 }] }
}
const dictionaries = { ...dataset.dictionaries, leadStages: { NEW: 'Новая заявка', 1: 'Взято в работу' } }

function render(props: Partial<{ report: ReportMetrics, pending: boolean, deferred: boolean, error: string, estimateMinutes: number }> = {}) {
  return mountSuspended(ReportProcessing, { props: { report: counted, dictionaries, ...props } })
}

describe('ReportProcessing', () => {
  it('счётчики на месте, время ждёт историю — прочерк и подпись, не ноль', async () => {
    const text = (await render({ pending: true, estimateMinutes: 2 })).text()
    expect(text).toContain('96')
    expect(text).toContain('ждёт историю стадий')
    expect(text).toContain('Считаем время первого ответа')
    expect(text).toContain('примерно 2 мин')
    expect(text).not.toContain('Обработанных лидов нет')
  })

  it('на длинном периоде — кнопка «Посчитать», по клику событие start', async () => {
    const wrapper = await render({ deferred: true, estimateMinutes: 24 })
    expect(wrapper.text()).toContain('примерно 24 мин')
    const button = wrapper.findAll('button').find((b: { text: () => string }) => b.text().includes('Посчитать'))!
    await button.trigger('click')
    expect(wrapper.emitted('start')).toHaveLength(1)
  })

  it('ошибка истории — плашка, счётчики целы', async () => {
    const text = (await render({ error: 'нет доступа' })).text()
    expect(text).toContain('Не удалось прочитать историю стадий')
    expect(text).toContain('96')
  })

  it('открытые лиды по стадиям — с именами из справочника', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('Взято в работу')
    expect(wrapper.text()).toContain('Новая заявка')
    const rows = wrapper.findAll('table').at(-1)!.findAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('30')
  })

  it('демо-набор: время посчитано по строкам, таблицы стадий нет', async () => {
    const wrapper = await render({ report: full })
    expect(wrapper.text()).not.toContain('ждёт историю стадий')
    expect(wrapper.text()).not.toContain('Открытые лиды по стадии')
  })
})
