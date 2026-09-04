// @vitest-environment nuxt
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportDrilldown from '~/components/ReportDrilldown.vue'
import type { DrillRow } from '~/utils/drilldown'
import { drill } from '~/utils/drilldown'

/**
 * Слайдер детализации рисуется порталом b24ui в `body`, поэтому текст читаем из документа, а не
 * из обёртки. Проверяем то, что живёт здесь: строки, кнопка «ещё», ссылка в CRM, подписи.
 */
const rows: DrillRow[] = [
  { id: 1, title: 'Лид первый', when: '2026-08-10T10:00:00+03:00', stage: 'Спам', source: 'Звонок', manager: 'Иванова Анна', path: '/crm/lead/details/1/' },
  { id: 2, title: 'Лид второй', path: '' }
]

let current: Awaited<ReturnType<typeof mountSuspended>> | undefined

async function render(props: Partial<{ rows: DrillRow[], pending: boolean, error: string, done: boolean, isDemo: boolean }> = {}) {
  current = await mountSuspended(ReportDrilldown, {
    props: { open: true, request: drill.junk(), rows, pending: false, done: true, isDemo: false, ...props },
    attachTo: document.body
  })
  await current.vm.$nextTick()
  return current
}

afterEach(() => {
  current?.unmount()
  current = undefined
  document.body.innerHTML = ''
})

const bodyText = () => document.body.textContent ?? ''
const buttons = () => Array.from(document.body.querySelectorAll('button'))

describe('ReportDrilldown', () => {
  it('заголовок — как подпись числа; строки с подписями; запись без карточки — не кнопка', async () => {
    await render()
    expect(bodyText()).toContain('Брак лидов')
    expect(bodyText()).toContain('лидов: 2')
    expect(bodyText()).toContain('Лид первый')
    expect(bodyText()).toContain('Иванова Анна')
    expect(bodyText()).toContain('10.08.2026')
    expect(buttons().some(b => b.textContent?.includes('Лид первый'))).toBe(true)
    expect(buttons().some(b => b.textContent?.includes('Лид второй'))).toBe(false)
  })

  it('клик по записи — событие с ней; «Показать ещё» — пока список не дочитан', async () => {
    const wrapper = await render({ done: false })
    expect(bodyText()).toContain('есть ещё')
    const link = buttons().find(b => b.textContent?.includes('Лид первый'))!
    link.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('openRow')?.[0]?.[0]).toMatchObject({ id: 1 })
    const more = buttons().find(b => b.textContent?.includes('Показать ещё'))!
    more.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('more')).toHaveLength(1)
  })

  it('пусто и дочитано — «Записей нет»; ошибка — плашка; демо — подпись про вымышленные записи', async () => {
    await render({ rows: [] })
    expect(bodyText()).toContain('Записей нет')
    current?.unmount()
    await render({ error: 'нет доступа', isDemo: true })
    expect(bodyText()).toContain('Не удалось прочитать записи')
    expect(bodyText()).toContain('карточек в CRM у них нет')
  })
})
