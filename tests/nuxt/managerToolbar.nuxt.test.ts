// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import type { DefineComponent } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { B24SelectMenu } from '#components'
import ManagerToolbar from '~/components/ManagerToolbar.vue'
import type { ManagerFilters } from '~/types/managers'
import { COMPANY_UNSET } from '~/utils/managerLoad'

/**
 * Панель отбора отчёта «Сделки по менеджерам». Проверяем то, что определяет ВСЕ числа на экране:
 * какие есть направления, что значит охват, какие компании можно выбрать и какой период считается.
 */
const TODAY = new Date(2026, 8, 5)

/** Умолчание отчёта — текущий месяц: «за всё время» убрано решением владельца от 2026-09-05. */
const PERIOD = { from: '2026-09-01', to: '2026-09-30' }

const CATEGORIES = [
  { id: 0, name: 'Общее направление' },
  { id: 1, name: 'Оптовые продажи' }
]

const STAGES = [
  { id: 'NEW', name: 'Новая', semantic: 'P' as const },
  { id: 'WON', name: 'Успех', semantic: 'S' as const },
  { id: 'LOSE', name: 'Отказ', semantic: 'F' as const }
]

const COMPANIES = [
  { id: 10, name: 'Минск' },
  { id: 20, name: 'Гомель' },
  { id: COMPANY_UNSET, name: 'Не указана' }
]

const COMPANY_TOTALS = { 10: 27, 20: 13, [COMPANY_UNSET]: 17 }

const FILTERS: ManagerFilters = { categoryId: 0, scope: 'in-work', period: PERIOD, companyId: 10 }

async function mount(props: Partial<InstanceType<typeof ManagerToolbar>['$props']> = {}) {
  return mountSuspended(ManagerToolbar, {
    props: {
      categories: CATEGORIES,
      stages: STAGES,
      companies: COMPANIES,
      companyTotals: COMPANY_TOTALS,
      appliedFilters: FILTERS,
      isDemo: false,
      today: TODAY,
      modelValue: FILTERS,
      ...props
    }
  })
}

/**
 * Списки панели по порядку: направление, охват, «моя компания».
 *
 * ⚠ По подписи их не найти: `aria-label` уходит в разметку внутрь компонента, а не в его
 * свойства. Порядок здесь — часть проверки: он же определяет порядок чтения с клавиатуры.
 */
const MENUS = ['Направление', 'Какие сделки считать'] as const

function menu(wrapper: Awaited<ReturnType<typeof mount>>, label: (typeof MENUS)[number]) {
  const found = wrapper.findAllComponents(B24SelectMenu as unknown as DefineComponent)[MENUS.indexOf(label)]
  if (!found) throw new Error(`нет списка «${label}»`)
  return found
}

/** Кнопка по подписи: периоды и компании — обычные кнопки, а не пункты списка. */
function button(wrapper: Awaited<ReturnType<typeof mount>>, label: string) {
  const found = wrapper.findAll('button').find(item => item.text() === label)
  if (!found) throw new Error(`нет кнопки «${label}»`)
  return found
}

/** Кнопка компании: подпись плюс число сделок рядом. */
function companyButton(wrapper: Awaited<ReturnType<typeof mount>>, label: string) {
  const found = wrapper.find('[data-testid="company-filter"]').findAll('button').find(item => item.text().startsWith(label))
  if (!found) throw new Error(`нет кнопки компании «${label}»`)
  return found
}

describe('ManagerToolbar', () => {
  it('направления берутся из справочника портала', async () => {
    const items = (menu(await mount(), 'Направление').props() as Record<string, unknown>).items as Array<{ label: string }>
    expect(items.map(item => item.label)).toEqual(['Общее направление', 'Оптовые продажи'])
  })

  it('охват — четыре понятных варианта', async () => {
    const items = (menu(await mount(), 'Какие сделки считать').props() as Record<string, unknown>).items as Array<{ label: string }>
    expect(items.map(item => item.label)).toEqual(['В работе', 'Успешные', 'Провальные', 'Все стадии'])
  })

  /**
   * ⚠ Компания выбирается КНОПКАМИ, как период, и показывается ОДНА за раз (решение владельца от
   * 2026-09-05). Пункта «все» нет: круг, поделённый между компаниями, отдавал одной почти всё, и
   * менеджеры сжимались в штриховку по краю.
   */
  it('компании — кнопки с числами, без пункта «все»', async () => {
    const wrapper = await mount()
    const labels = wrapper.find('[data-testid="company-filter"]').findAll('button').map(item => item.text())
    expect(labels).toEqual(['Минск27', 'Гомель13', 'Без моей компании17'])
    expect(labels.some(label => label.includes('Все компании'))).toBe(false)
  })

  it('выбранная компания подсвечена', async () => {
    const wrapper = await mount()
    expect(companyButton(wrapper, 'Минск').attributes('aria-pressed')).toBe('true')
    expect(companyButton(wrapper, 'Гомель').attributes('aria-pressed')).toBe('false')
  })

  it('«за всё время» из панели убрано — выбирать можно только конкретный период', async () => {
    const text = (await mount()).text()
    expect(text).not.toContain('За всё время')
    expect(text).toContain('Текущий месяц')
  })

  it('выбор направления уходит наружу целым отбором', async () => {
    const wrapper = await mount()
    await menu(wrapper, 'Направление').vm.$emit('update:modelValue', 1)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ ...FILTERS, categoryId: 1 })
  })

  // ⚠ Ноль — это «Без моей компании», а не «не задано». Проверяем именно его: подмена нуля на
  // «все» — самая вероятная ошибка в этом фильтре, и заметить её на экране нельзя.
  it('«без моей компании» уходит нулём', async () => {
    const wrapper = await mount()
    await companyButton(wrapper, 'Без моей компании').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ ...FILTERS, companyId: COMPANY_UNSET })
  })

  // Повторное нажатие на уже выбранную компанию — это полная выборка отчёта ради того же экрана.
  it('повторное нажатие выбранной компании ничего не меняет', async () => {
    const wrapper = await mount()
    await companyButton(wrapper, 'Минск').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('кнопка интервала кладёт в отбор границы', async () => {
    const wrapper = await mount({ modelValue: { ...FILTERS, period: { from: '2026-08-01', to: '2026-08-31' } } })
    await button(wrapper, 'Текущий месяц').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual(FILTERS)
  })

  // Подпись обязана говорить, по чему посчитаны числа, включая слово «созданы»: период считается
  // по дате СОЗДАНИЯ сделки, и без этого числа читались бы как «сколько сейчас в работе».
  it('подписывает применённый отбор словами', async () => {
    const text = (await mount()).text()
    expect(text).toContain('Общее направление: в работе (стадий в охвате: 1 из 3), Минск, созданы 01.09.2026 — 30.09.2026')
  })

  it('в подписи видно выбранную компанию', async () => {
    const wrapper = await mount({ appliedFilters: { ...FILTERS, companyId: 20 } })
    expect(wrapper.text()).toContain('Гомель, созданы')
  })

  it('говорит вслух, что данные демонстрационные', async () => {
    expect((await mount({ isDemo: true })).text()).toContain('Демо-данные')
    expect((await mount()).text()).not.toContain('Демо-данные')
  })
})

describe('ManagerToolbar: защита от лишних выборок', () => {
  // Каждая смена отбора — секунд пятнадцать запросов к порталу; во время выборки списки закрыты.
  it('во время выборки списки заблокированы', async () => {
    const wrapper = await mount({ disabled: true })
    for (const item of wrapper.findAllComponents(B24SelectMenu as unknown as DefineComponent)) {
      expect((item.props() as Record<string, unknown>).disabled).toBe(true)
    }
  })

  it('мусорное значение из списка отбор не меняет', async () => {
    const wrapper = await mount()
    await menu(wrapper, 'Направление').vm.$emit('update:modelValue', 'не число')
    await menu(wrapper, 'Какие сделки считать').vm.$emit('update:modelValue', 'чужой охват')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('без направлений список закрыт: выбирать нечего', async () => {
    const wrapper = await mount({ categories: [] })
    expect((menu(wrapper, 'Направление').props() as Record<string, unknown>).disabled).toBe(true)
  })

  // Пока компаний не нашли (первая выборка ещё идёт), кнопок нет вовсе — выбирать нечего.
  it('без компаний ряда кнопок нет', async () => {
    const wrapper = await mount({ companies: [] })
    expect(wrapper.find('[data-testid="company-filter"]').exists()).toBe(false)
  })

  it('во время выборки кнопки компаний закрыты', async () => {
    const wrapper = await mount({ disabled: true })
    expect(companyButton(wrapper, 'Гомель').attributes('disabled')).toBeDefined()
    await companyButton(wrapper, 'Гомель').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
