// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportSummary from '~/components/ReportSummary.vue'
import { buildReport } from '~/utils/metrics'
import { buildMockDataset } from '~/utils/mockReport'
import { nbsp } from '../helpers/text'

/**
 * Проверяем не вёрстку, а СВЯЗЬ ядра с экраном: что на плитках оказываются посчитанные числа и
 * что подпись доли называет знаменатель. Именно молчаливая подмена знаменателя и делает два
 * разных отчёта одинаково правдоподобными на вид.
 */
const dataset = buildMockDataset()

async function render(conversionBase: 'quality-leads' | 'all-leads') {
  const report = buildReport(dataset.leads, dataset.deals, { conversionBase })
  const wrapper = await mountSuspended(ReportSummary, {
    props: { report, currencyId: dataset.currencyId }
  })
  // `ru-RU` разделяет разряды неразрывным пробелом (U+00A0), иногда узким (U+202F).
  // Escape-последовательностями намеренно: набранные буквально, они неотличимы от обычного
  // пробела при чтении диффа.
  return nbsp(wrapper.text())
}

describe('ReportSummary', () => {
  it('печатает числа сводки', async () => {
    const text = await render('all-leads')
    expect(text).toContain('1 250')
    expect(text).toContain('485 000 BYN')
  })

  it('при базе «все лиды» показывает конверсии макета и называет знаменатель', async () => {
    const text = await render('all-leads')
    expect(text).toContain('80 %')
    expect(text).toContain('49,6 % от лидов')
  })

  it('при базе ТЗ те же данные дают другие проценты и другую подпись', async () => {
    const text = await render('quality-leads')
    expect(text).toContain('62 % от качественных лидов')
    expect(text).toContain('знаменатель: 1 000')
  })

  it('доля брака в обеих базах одна и та же', async () => {
    for (const base of ['all-leads', 'quality-leads'] as const) {
      expect(await render(base)).toContain('20 % от лидов')
    }
  })
})
