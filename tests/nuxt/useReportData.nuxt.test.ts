// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { useReportData } from '~/composables/useReportData'

/**
 * Умолчания этого композабла — не вкусовщина разработчика, а ВЫБОР ЗАКАЗЧИКА от 2026-09-03.
 * Смена базы конверсий меняет числа на экране вдвое (80 % против 100 %), и защищена она была
 * только комментарием: ни один тест до этого не читал дефолты — все передавали `ReportOptions`
 * явно. Случайный откат при слиянии прошёл бы мимо CI и всплыл бы у клиента.
 */
describe('умолчания отчёта', () => {
  it('конверсии считаются от ВСЕХ лидов — выбор заказчика, а не формула ТЗ', () => {
    expect(useReportData().conversionBase.value).toBe('all-leads')
  })

  it('норматив первого ответа — 120 минут', () => {
    expect(useReportData().firstResponseSlaMinutes.value).toBe(120)
  })
})
