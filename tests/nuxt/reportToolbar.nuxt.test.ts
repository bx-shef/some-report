// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportToolbar from '~/components/ReportToolbar.vue'

/**
 * Панель отчёта: подпись периода, признак демо и выбор интервала. Переключателя знаменателя
 * здесь больше нет (решение владельца от 2026-09-04) — и тест сторожит, что он не вернулся:
 * два ответа на один вопрос рядом с заголовком подрывали доверие к числу.
 */
const period = { from: '2026-08-01', to: '2026-08-31' }
/** 3 сентября 2026 — день, когда заказчик открыл отчёт и увидел пустой текущий месяц. */
const TODAY = new Date(2026, 8, 3)

function mount(props: Partial<InstanceType<typeof ReportToolbar>['$props']> = {}) {
  return mountSuspended(ReportToolbar, {
    props: { period, isDemo: true, today: TODAY, ...props }
  })
}

describe('ReportToolbar', () => {
  it('печатает период по-русски', async () => {
    expect((await mount()).text()).toContain('01.08.2026 — 31.08.2026')
  })

  it('переключателя знаменателя на панели нет — знаменатель один, по ТЗ', async () => {
    const text = (await mount()).text()
    expect(text).not.toContain('Конверсии считать от')
    expect(text).not.toContain('Все лиды')
  })

  it('календарная неделя есть среди интервалов', async () => {
    const labels = (await mount()).findAll('button').map((b: { text: () => string }) => b.text())
    expect(labels).toContain('Текущая неделя')
    expect(labels).toContain('Прошлая неделя')
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
