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
/** 3 сентября 2026 — день, когда заказчик открыл отчёт и увидел пустой текущий месяц. */
const TODAY = new Date(2026, 8, 3)

function mount(props: Partial<InstanceType<typeof ReportToolbar>['$props']> = {}) {
  return mountSuspended(ReportToolbar, {
    props: { conversionBase: 'quality-leads', period, isDemo: true, today: TODAY, ...props }
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
  // ⚠ Ищем ВНУТРИ fieldset базы: рядом на панели живут кнопки периода, у них своя отметка.
  it('отмечает активную базу для вспомогательных технологий', async () => {
    const wrapper = await mount({ conversionBase: 'all-leads' })
    const pressed = wrapper.find('fieldset').findAll('button')
      .filter((b: { attributes: (n: string) => string | undefined }) => b.attributes('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.text()).toBe('Все лиды')
  })

  it('говорит вслух, что данные демонстрационные', async () => {
    expect((await mount()).text()).toContain('Демо-данные')
    expect((await mount({ isDemo: false })).text()).not.toContain('Демо-данные')
  })
})

describe('выбор периода', () => {
  async function pick(wrapper: Awaited<ReturnType<typeof mount>>, label: string) {
    const button = wrapper.findAll('button').find((b: { text: () => string }) => b.text() === label)
    if (!button) throw new Error(`нет кнопки «${label}»`)
    await button.trigger('click')
  }

  it('показывает готовые интервалы', async () => {
    const text = (await mount()).text()
    expect(text).toContain('Текущий месяц')
    expect(text).toContain('Прошлый месяц')
    expect(text).toContain('Произвольный')
  })

  it('«Текущий месяц» просит сентябрь целиком', async () => {
    const wrapper = await mount()
    await pick(wrapper, 'Текущий месяц')
    expect(wrapper.emitted('update:period')).toEqual([[{ from: '2026-09-01', to: '2026-09-30' }]])
  })

  // ⚠ Ради этого интервал и заведён: отчёт, открытый 3-го числа, показывает три дня — почти пустой
  // экран, который читается как поломка.
  it('«Прошлый месяц» просит август целиком', async () => {
    const wrapper = await mount()
    await pick(wrapper, 'Прошлый месяц')
    expect(wrapper.emitted('update:period')).toEqual([[{ from: '2026-08-01', to: '2026-08-31' }]])
  })

  // Иначе человек видит, что система не понимает того, что он только что выбрал.
  it('подсвечивает интервал, совпавший с текущим периодом', async () => {
    const wrapper = await mount({ period: { from: '2026-08-01', to: '2026-08-31' } })
    const button = wrapper.findAll('button').find((b: { text: () => string }) => b.text() === 'Прошлый месяц')
    expect(button?.attributes('aria-pressed')).toBe('true')
  })

  it('«Произвольный» не просит новый период сам по себе — его задаёт человек', async () => {
    const wrapper = await mount()
    await pick(wrapper, 'Произвольный')
    expect(wrapper.emitted('update:period')).toBeUndefined()
    // Вместо этого разворачивается поле с календарём — период задаст человек.
    expect(wrapper.find('[data-testid="period-input"]').exists()).toBe(true)
  })
})
