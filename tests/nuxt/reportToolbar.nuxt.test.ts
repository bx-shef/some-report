// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportToolbar from '~/components/ReportToolbar.vue'

/**
 * Единственный интерактивный элемент отчёта — переключатель знаменателя конверсий. Ошибка в нём
 * не даст ни ошибки типов, ни видимой поломки: отчёт просто покажет проценты не от той базы.
 * Именно поэтому он покрыт, а не «на глаз».
 */
const period = { from: '2026-08-01', to: '2026-08-31' }

function mount(props: Partial<InstanceType<typeof ReportToolbar>['$props']> = {}) {
  return mountSuspended(ReportToolbar, {
    props: { conversionBase: 'quality-leads', period, isDemo: true, ...props }
  })
}

describe('ReportToolbar', () => {
  it('печатает период по-русски', async () => {
    expect((await mount()).text()).toContain('01.08.2026 — 31.08.2026')
  })

  it('нажатие на «Все лиды» просит сменить базу именно на неё', async () => {
    const wrapper = await mount()
    const all = wrapper.findAll('button').find(b => b.text() === 'Все лиды')!
    await all.trigger('click')
    expect(wrapper.emitted('update:conversionBase')).toEqual([['all-leads']])
  })

  it('нажатие на «Качественные лиды» просит сменить базу на неё', async () => {
    const wrapper = await mount({ conversionBase: 'all-leads' })
    const quality = wrapper.findAll('button').find(b => b.text() === 'Качественные лиды')!
    await quality.trigger('click')
    expect(wrapper.emitted('update:conversionBase')).toEqual([['quality-leads']])
  })

  // Активная база должна быть видна не только цветом: скринридер читает aria-pressed.
  it('отмечает активную базу для вспомогательных технологий', async () => {
    const wrapper = await mount({ conversionBase: 'all-leads' })
    const pressed = wrapper.findAll('button').filter(b => b.attributes('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.text()).toBe('Все лиды')
  })

  it('говорит вслух, что данные демонстрационные', async () => {
    expect((await mount()).text()).toContain('Демо-данные')
    expect((await mount({ isDemo: false })).text()).not.toContain('Демо-данные')
  })
})
