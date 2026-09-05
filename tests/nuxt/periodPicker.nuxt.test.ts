// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PeriodPicker from '~/components/PeriodPicker.vue'

/**
 * Выбор периода целиком: кнопки, календарь и жалобы. Один компонент на обе панели.
 *
 * ⚠ Проверяем склейку разметки с логикой — то, чего не видит тест композабла: подписи и
 * `aria-label` (у отчётов они разные и не случайно), запрет во время выборки и то, что блок не
 * попадает в PDF-снимок.
 */
const TODAY = new Date(2026, 8, 15)
const MONTH = { from: '2026-09-01', to: '2026-09-30' }

function mount(props: Partial<InstanceType<typeof PeriodPicker>['$props']> = {}) {
  return mountSuspended(PeriodPicker, { props: { period: MONTH, today: TODAY, ...props } })
}

function button(wrapper: Awaited<ReturnType<typeof mount>>, label: string) {
  const found = wrapper.findAll('button').find(item => item.text() === label)
  if (!found) throw new Error(`нет кнопки «${label}»`)
  return found
}

describe('PeriodPicker', () => {
  it('рисует все готовые интервалы и подсвечивает выбранный', async () => {
    const wrapper = await mount()
    expect(wrapper.text()).toContain('Текущий месяц')
    expect(wrapper.text()).toContain('Произвольный')
    expect(button(wrapper, 'Текущий месяц').attributes('aria-pressed')).toBe('true')
    expect(button(wrapper, 'Прошлый месяц').attributes('aria-pressed')).toBe('false')
  })

  it('выбор интервала уходит наружу событием', async () => {
    const wrapper = await mount()
    await button(wrapper, 'Прошлый месяц').trigger('click')
    expect(wrapper.emitted('update:period')).toEqual([[{ from: '2026-08-01', to: '2026-08-31' }]])
  })

  // ⚠ Подпись у отчётов разная не для красоты: во втором период считается по дате СОЗДАНИЯ
  // сделки, и «Созданы:» — единственное, что говорит об этом рядом с кнопками.
  it('подпись и метка группы задаются панелью', async () => {
    expect((await mount()).text()).toContain('Период:')
    const managers = await mount({ caption: 'Созданы:', groupLabel: 'Период создания сделок' })
    expect(managers.text()).toContain('Созданы:')
    expect(managers.find('[role="group"]').attributes('aria-label')).toBe('Период создания сделок')
  })

  it('«Произвольный» разворачивает календарь и сам период не просит', async () => {
    const wrapper = await mount()
    await button(wrapper, 'Произвольный').trigger('click')
    expect(wrapper.find('[data-testid="period-input"]').exists()).toBe(true)
    expect(wrapper.emitted('update:period')).toBeUndefined()
  })

  // Кнопка помечена `aria-pressed`, то есть обещает и отжатое состояние.
  it('повторное нажатие «Произвольного» сворачивает календарь', async () => {
    const wrapper = await mount()
    await button(wrapper, 'Произвольный').trigger('click')
    await button(wrapper, 'Произвольный').trigger('click')
    expect(wrapper.find('[data-testid="period-input"]').exists()).toBe(false)
  })

  /**
   * ⚠ Во время выборки период не меняют: каждая смена — секунды запросов к порталу. Кнопки
   * закрыты атрибутом, календарь — видом и запретом в логике (своего `disabled` у поля дат нет).
   */
  it('во время выборки кнопки закрыты и период не меняется', async () => {
    const wrapper = await mount({ disabled: true })
    expect(button(wrapper, 'Прошлый месяц').attributes('disabled')).toBeDefined()
    await button(wrapper, 'Прошлый месяц').trigger('click')
    expect(wrapper.emitted('update:period')).toBeUndefined()
  })

  // Нестандартный период (восстановленный из настроек портала) открывает календарь сам: иначе
  // человек видел бы даты, которые нечем поправить.
  it('нестандартный период сразу показывает календарь', async () => {
    const wrapper = await mount({ period: { from: '2026-09-03', to: '2026-09-17' } })
    expect(wrapper.find('[data-testid="period-input"]').exists()).toBe(true)
    expect(button(wrapper, 'Произвольный').attributes('aria-pressed')).toBe('true')
  })

  // В PDF-снимок кнопки не попадают: период там печатается подписью, а не элементами управления.
  it('блок помечен как не попадающий в снимок', async () => {
    const wrapper = await mount()
    expect(wrapper.findAll('[data-export-exclude]').length).toBeGreaterThan(0)
  })
})
