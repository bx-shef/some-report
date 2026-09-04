// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PeriodField from '~/components/PeriodField.vue'

/**
 * Поле-диапазон: строка `ГГГГ-ММ-ДД` ↔ календарная дата библиотеки.
 *
 * ⚠ Месяц у `Date` с нуля, у `CalendarDate` с единицы — ошибка на единицу здесь не падает, а
 * тихо сдвигает весь период на месяц. Поэтому обе стороны преобразования под тестом.
 */
const TODAY = new Date(2026, 8, 3)

async function mount(from = '', to = '') {
  return mountSuspended(PeriodField, { props: { from, to, today: TODAY } })
}

/** Календарь b24ui эмитит диапазон — находим его и эмитим сами, как сделал бы клик. */
function calendarOf(wrapper: Awaited<ReturnType<typeof mount>>) {
  return wrapper.findComponent({ name: 'B24Calendar' })
}

/**
 * Открыт ли поповер — по его `open`, а не по наличию календаря в DOM.
 *
 * ⚠ Содержимое поповера в тестовой среде может оставаться смонтированным после закрытия, и
 * `exists()` у календаря не отличает «открыт» от «закрыт, но ещё в DOM».
 */
function popoverOpen(wrapper: Awaited<ReturnType<typeof mount>>): boolean {
  return Boolean(wrapper.findComponent({ name: 'B24Popover' }).props('open'))
}

describe('PeriodField', () => {
  it('показывает границы периода в поле', async () => {
    const wrapper = await mount('2026-08-01', '2026-08-31')
    const text = wrapper.find('[data-testid="period-input"]').text().replace(/\s/g, '')
    expect(text).toContain('01')
    expect(text).toContain('08')
    expect(text).toContain('2026')
    expect(text).toContain('31')
  })

  it('открывает календарь по кнопке', async () => {
    const wrapper = await mount('2026-08-01', '2026-08-31')
    expect(popoverOpen(wrapper)).toBe(false)
    await wrapper.find('[data-testid="period-calendar-open"]').trigger('click')
    expect(popoverOpen(wrapper)).toBe(true)
  })

  // ⚠ У периода два клика: закрытие после первого не дало бы выбрать конец.
  it('после одной границы остаётся открытым, после второй — закрывается и отдаёт обе', async () => {
    const wrapper = await mount()
    await wrapper.find('[data-testid="period-calendar-open"]').trigger('click')
    const calendar = calendarOf(wrapper)
    const { CalendarDate } = await import('@internationalized/date')

    calendar.vm.$emit('update:modelValue', { start: new CalendarDate(2026, 8, 5), end: undefined })
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:from')?.at(-1)).toEqual(['2026-08-05'])
    // Конец не выбран — `to` остался пустым, и Vue не шлёт событие о неизменившемся значении.
    expect(wrapper.emitted('update:to')).toBeUndefined()
    expect(popoverOpen(wrapper)).toBe(true)

    calendar.vm.$emit('update:modelValue', { start: new CalendarDate(2026, 8, 5), end: new CalendarDate(2026, 8, 20) })
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:to')?.at(-1)).toEqual(['2026-08-20'])
    expect(popoverOpen(wrapper)).toBe(false)
  })

  it('високосный день переживает преобразование туда и обратно', async () => {
    const wrapper = await mount()
    await wrapper.find('[data-testid="period-calendar-open"]').trigger('click')
    const { CalendarDate } = await import('@internationalized/date')
    calendarOf(wrapper).vm.$emit('update:modelValue', { start: new CalendarDate(2028, 2, 29), end: new CalendarDate(2028, 2, 29) })
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:from')?.at(-1)).toEqual(['2028-02-29'])
  })
})
