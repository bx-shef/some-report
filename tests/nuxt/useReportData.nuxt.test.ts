// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { useReportData } from '~/composables/useReportData'

/**
 * Умолчания этого композабла — не вкусовщина разработчика, а РЕШЕНИЕ по ТЗ от 2026-09-04.
 * Смена базы конверсий меняет числа на экране вдвое (100 % против 80 %), и защищена она была
 * только комментарием: ни один тест до этого не читал дефолты — все передавали `ReportOptions`
 * явно. Случайный откат при слиянии прошёл бы мимо CI и всплыл бы у клиента.
 */
describe('умолчания отчёта', () => {
  it('конверсии считаются от лидов БЕЗ брака — формула ТЗ, решение владельца от 2026-09-04', () => {
    const { report } = useReportData()
    expect(report.value.summary.conversionBase).toBe('quality-leads')
    // Демо-набор: 1 250 лидов, 250 брака → база 1 000, конверсия в сделку 100 %.
    expect(report.value.summary.conversionBaseValue).toBe(1000)
  })

  it('норматив первого ответа — 120 минут', () => {
    expect(useReportData().firstResponseSlaMinutes.value).toBe(120)
  })
})
