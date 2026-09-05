// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import type { DefineComponent } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { B24SelectMenu } from '#components'
import ManagerToolbar from '~/components/ManagerToolbar.vue'
import type { ManagerFilters } from '~/types/managers'

/**
 * Панель отбора отчёта «Сделки по менеджерам». Проверяем то, что определяет ВСЕ числа на экране:
 * какие есть направления, что значит охват и как выбирается период.
 */
const TODAY = new Date(2026, 8, 5)

const CATEGORIES = [
  { id: 0, name: 'Общее направление' },
  { id: 1, name: 'Оптовые продажи' }
]

const STAGES = [
  { id: 'NEW', name: 'Новая', semantic: 'P' as const },
  { id: 'WON', name: 'Успех', semantic: 'S' as const },
  { id: 'LOSE', name: 'Отказ', semantic: 'F' as const }
]

async function mount(props: Partial<InstanceType<typeof ManagerToolbar>['$props']> = {}) {
  return mountSuspended(ManagerToolbar, {
    props: {
      categories: CATEGORIES,
      stages: STAGES,
      appliedFilters: { categoryId: 0, scope: 'in-work' } as ManagerFilters,
      isDemo: false,
      today: TODAY,
      modelValue: { categoryId: 0, scope: 'in-work' } as ManagerFilters,
      ...props
    }
  })
}

/**
 * Списки панели по порядку: направление, охват, период.
 *
 * ⚠ По подписи их не найти: `aria-label` уходит в разметку внутрь компонента, а не в его
 * свойства. Порядок здесь — часть проверки: он же определяет порядок чтения с клавиатуры.
 */
const MENUS = ['Направление', 'Какие сделки считать', 'Период создания сделки'] as const

function menu(wrapper: Awaited<ReturnType<typeof mount>>, label: (typeof MENUS)[number]) {
  const found = wrapper.findAllComponents(B24SelectMenu as unknown as DefineComponent)[MENUS.indexOf(label)]
  if (!found) throw new Error(`нет списка «${label}»`)
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

  // «За всё время» — умолчание: сделка в работе с прошлого квартала это работа сегодня.
  it('первый пункт периода — «За всё время», и он выбран по умолчанию', async () => {
    const wrapper = await mount()
    const period = menu(wrapper, 'Период создания сделки').props() as Record<string, unknown>
    expect((period.items as Array<{ label: string }>)[0]!.label).toBe('За всё время')
    expect(period.modelValue).toBe('all-time')
  })

  it('выбор направления уходит наружу целым отбором', async () => {
    const wrapper = await mount()
    await menu(wrapper, 'Направление').vm.$emit('update:modelValue', 1)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ categoryId: 1, scope: 'in-work' })
  })

  it('выбор интервала кладёт в отбор границы, а «за всё время» — убирает период', async () => {
    const wrapper = await mount()
    await menu(wrapper, 'Период создания сделки').vm.$emit('update:modelValue', 'this-month')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      categoryId: 0,
      scope: 'in-work',
      period: { from: '2026-09-01', to: '2026-09-30' }
    })

    const withPeriod = await mount({ modelValue: { categoryId: 0, scope: 'in-work', period: { from: '2026-09-01', to: '2026-09-30' } } })
    await menu(withPeriod, 'Период создания сделки').vm.$emit('update:modelValue', 'all-time')
    expect(withPeriod.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ categoryId: 0, scope: 'in-work' })
  })

  // Подпись обязана говорить, по чему посчитаны числа: направление, охват и сколько стадий в нём.
  it('подписывает применённый отбор словами', async () => {
    expect((await mount()).text()).toContain('Общее направление: в работе (стадий в охвате: 1 из 3), за всё время')
  })

  it('говорит вслух, что данные демонстрационные', async () => {
    expect((await mount({ isDemo: true })).text()).toContain('Демо-данные')
    expect((await mount()).text()).not.toContain('Демо-данные')
  })
})
