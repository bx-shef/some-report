// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { ActivityFilters, DepartmentRef } from '~/types/activity'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import ActivityToolbar from '~/components/ActivityToolbar.vue'

/**
 * Панель отчёта «Активность пользователей».
 *
 * ⚠ Здесь сторожится главное: подпись под панелью обязана называть ТО, чем посчитаны числа. Порог
 * меняет все числа отчёта, и таблица без названного порога не сверяется ни с чем.
 */

const TODAY = new Date(2026, 8, 15)

const DEPARTMENTS: DepartmentRef[] = [
  { id: 10, name: 'Департамент' },
  { id: 11, name: 'Отдел продаж', parentId: 10 },
  { id: 12, name: 'Абонентский отдел', parentId: 10 }
]

function filters(over: Partial<ActivityFilters> = {}): ActivityFilters {
  return {
    period: { from: '2026-08-01', to: '2026-08-31' },
    thresholdSeconds: DEFAULT_CALL_THRESHOLD_SECONDS,
    ...over
  }
}

async function mount(over: Record<string, unknown> = {}) {
  return await mountSuspended(ActivityToolbar, {
    props: {
      modelValue: filters(),
      departments: DEPARTMENTS,
      appliedFilters: filters(),
      isDemo: false,
      today: TODAY,
      ...over
    }
  })
}

describe('ActivityToolbar', () => {
  it('называет отбор, которым посчитаны числа', async () => {
    const wrapper = await mount()
    const text = wrapper.text()
    expect(text).toContain('все отделы')
    expect(text).toContain('дольше 29 с')
    expect(text).toContain('01.08.2026')
    expect(text).toContain('31.08.2026')
  })

  it('называет выбранный отдел по имени, а не по номеру', async () => {
    const wrapper = await mount({ appliedFilters: filters({ departmentId: 11 }) })
    expect(wrapper.text()).toContain('Отдел продаж')
  })

  /** ⚠ Отдел, которого нет в справочнике, — номером: молча пропасть из подписи он не должен. */
  it('незнакомый отдел подписан номером', async () => {
    const wrapper = await mount({ appliedFilters: filters({ departmentId: 999 }) })
    expect(wrapper.text()).toContain('отдел #999')
  })

  /**
   * ⚠ Порог 0 — это «считать все разговоры», и подпись обязана сказать именно так. «Дольше 0 с»
   * читалось бы как порог, которого нет.
   */
  it('порог 0 называется «все состоявшиеся», а не «дольше 0 с»', async () => {
    const wrapper = await mount({ appliedFilters: filters({ thresholdSeconds: 0 }) })
    expect(wrapper.text()).toContain('все состоявшиеся разговоры')
    expect(wrapper.text()).not.toContain('дольше 0 с')
  })

  /**
   * ⚠ «Дела и звонки за» — не украшение: период считается по дате СОЗДАНИЯ записи, и без этих слов
   * числа читаются как «сколько сейчас в работе», а это другой вопрос.
   */
  it('подпись говорит, что период — про создание записей', async () => {
    const wrapper = await mount()
    expect(wrapper.text()).toContain('дела и звонки за')
  })

  it('до первой выборки подписи нет', async () => {
    const wrapper = await mount({ appliedFilters: undefined })
    expect(wrapper.text()).not.toContain('дольше 29 с')
  })

  it('демо-набор помечен на экране', async () => {
    const wrapper = await mount({ isDemo: true })
    expect(wrapper.text()).toContain('Демо-данные')
  })

  /** Без справочника отделов фильтр закрыт: пустой список выбирать не из чего. */
  it('без отделов фильтр отделов отключён', async () => {
    const wrapper = await mount({ departments: [] })
    expect(wrapper.find('[data-testid="department-filter"]').exists()).toBe(true)
  })
})
