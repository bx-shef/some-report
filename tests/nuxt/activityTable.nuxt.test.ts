// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { ActivityReport } from '~/types/activity'
import ActivityTable from '~/components/ActivityTable.vue'
import ActivitySummary from '~/components/ActivitySummary.vue'
import { aggregateCalls, buildActivityReport, deedKey, leadKey, overdueKey } from '~/utils/activityLoad'

/**
 * Таблица и плитки отчёта «Активность пользователей».
 *
 * ⚠ Отчёт собирается ЯДРОМ, а не руками: если бы стенд строил `ActivityReport` литералом, тест
 * проверял бы разметку по числам, которых ядро не выдаёт, и разошёлся бы с экраном молча.
 */

function report(options: { withCalls: boolean } = { withCalls: true }): ActivityReport {
  const totals = {
    [deedKey(1, 'email', 'out')]: 12,
    [deedKey(1, 'email', 'in')]: 3,
    [deedKey(1, 'meeting')]: 2,
    [deedKey(1, 'task')]: 4,
    [overdueKey(1)]: 5,
    [leadKey(1, 'created')]: 20,
    [leadKey(1, 'won')]: 7,
    [leadKey(1, 'lost')]: 9
  }
  const calls = aggregateCalls([
    { PORTAL_USER_ID: '1', CALL_TYPE: '1', CALL_DURATION: '120', CALL_FAILED_CODE: '200' },
    { PORTAL_USER_ID: '1', CALL_TYPE: '2', CALL_DURATION: '90', CALL_FAILED_CODE: '200' },
    { PORTAL_USER_ID: '1', CALL_TYPE: '1', CALL_DURATION: '0', CALL_FAILED_CODE: '304' },
    { PORTAL_USER_ID: '7', CALL_TYPE: '1', CALL_DURATION: '60', CALL_FAILED_CODE: '200' }
  ])
  return buildActivityReport({
    users: [{ id: 1, name: 'Иванов Иван' }, { id: 2, name: 'Петров Пётр', dismissed: true }],
    totals,
    ...(options.withCalls ? { calls } : {})
  })
}

describe('ActivityTable', () => {
  it('печатает числа сотрудника и итог', async () => {
    const wrapper = await mountSuspended(ActivityTable, { props: { report: report() } })
    const text = wrapper.text()
    expect(text).toContain('Иванов Иван')
    expect(text).toContain('уволен')
    // Наговорил 120 + 90 = 210 секунд.
    expect(text).toContain('3 мин 30 с')
    expect(text).toContain('Итого')
  })

  /**
   * ⛔ Главное правило этого экрана: пока звонки не прочитаны, в их столбцах ПРОЧЕРК, а не ноль.
   * Ноль читается как «не звонил», и человек, открывший отчёт в первую секунду, прочитал бы его
   * именно так — а звонки идут полторы минуты.
   */
  it('без звонков их столбцы — прочерки, а дела уже числа', async () => {
    const wrapper = await mountSuspended(ActivityTable, { props: { report: report({ withCalls: false }) } })
    const text = wrapper.text()
    expect(text).toContain('—')
    // Дела при этом посчитаны и показаны.
    expect(text).toContain('12')
    expect(text).toContain('20')
  })

  /**
   * ⚠ Строке, которой дел не спрашивали (звонки чужого сотрудника), — тоже прочерк, и она это
   * объясняет: иначе ноль читался бы как «не писал» вместо «не спрашивали».
   */
  it('строка без спрошенных дел объясняет свои прочерки', async () => {
    const wrapper = await mountSuspended(ActivityTable, { props: { report: report() } })
    expect(wrapper.text()).toContain('Сотрудник #7')
    expect(wrapper.text()).toContain('вне выбранного отдела')
  })

  /** ⚠ На телефоне таблицы нет — там карточки: одиннадцать столбцов в 390 пикселей не влезают. */
  it('на телефоне карточки, на экране таблица — и данные в них одни и те же', async () => {
    const wrapper = await mountSuspended(ActivityTable, { props: { report: report() } })
    const cards = wrapper.find('[data-testid="activity-cards"]')
    expect(cards.exists()).toBe(true)
    expect(cards.classes()).toContain('lg:hidden')
    expect(cards.text()).toContain('Иванов Иван')
    const table = wrapper.find('table')
    expect(table.exists()).toBe(true)
    expect(table.text()).toContain('Иванов Иван')
  })

  /** Горизонтальная прокрутка живёт ВНУТРИ карточки: у всей страницы её быть не должно. */
  it('таблица прокручивается внутри карточки, а не растягивает страницу', async () => {
    const wrapper = await mountSuspended(ActivityTable, { props: { report: report() } })
    expect(wrapper.find('.overflow-x-auto').exists()).toBe(true)
  })

  it('пустой отбор — фраза, а не пустая таблица', async () => {
    const empty = buildActivityReport({ users: [], totals: {} })
    const wrapper = await mountSuspended(ActivityTable, { props: { report: empty } })
    expect(wrapper.text()).toContain('сотрудников нет')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})

describe('ActivitySummary', () => {
  it('плитки берут числа у ядра и называют порог', async () => {
    const wrapper = await mountSuspended(ActivitySummary, { props: { report: report() } })
    const text = wrapper.text()
    expect(text).toContain('Разговоров')
    expect(text).toContain('Наговорили')
    // Порог обязан быть назван: без него «короткие» — число без единицы измерения.
    expect(text).toContain('29 с')
  })

  it('без звонков плитки звонков — прочерки и объяснение', async () => {
    const wrapper = await mountSuspended(ActivitySummary, {
      props: { report: report({ withCalls: false }), callsPending: true }
    })
    expect(wrapper.text()).toContain('звонки ещё читаются')
  })

  /** ⚠ Созданные и закрытые лиды считаются по разным датам — плитка обязана это сказать. */
  it('плитка лидов объясняет, что закрытые считаются по дате закрытия', async () => {
    const wrapper = await mountSuspended(ActivitySummary, { props: { report: report() } })
    expect(wrapper.text()).toContain('закрыто за период')
  })
})
