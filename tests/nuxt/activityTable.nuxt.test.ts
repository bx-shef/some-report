// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { ActivityReport } from '~/types/activity'
import ActivityTable from '~/components/ActivityTable.vue'
import ActivitySummary from '~/components/ActivitySummary.vue'
import { aggregateCalls, buildActivityReport, deedKey, leadKey, overdueKey } from '~/utils/activityLoad'
import { provideDrillEnabled } from '~/composables/useDrillEnabled'

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
   * ⚠ Строке, которой дел не спрашивали, — тоже прочерк, и она это объясняет: иначе ноль читался
   * бы как «не писал» вместо «не спрашивали».
   *
   * ⛔ Причину называем ВЕРНУЮ. Прежняя подпись говорила «он вне выбранного отдела» — случай,
   * которого быть НЕ МОЖЕТ: под выбранным отделом такие звонки отсеивает `scopeCallsToUsers` ещё
   * до сборки. Строка появляется, когда владельца звонка не отдал `user.get` (бот, внештатник).
   */
  it('строка без спрошенных дел объясняет свои прочерки верной причиной', async () => {
    const wrapper = await mountSuspended(ActivityTable, { props: { report: report() } })
    expect(wrapper.text()).toContain('Сотрудник #7')
    expect(wrapper.text()).toContain('нет в списке сотрудников портала')
    expect(wrapper.text()).not.toContain('вне выбранного отдела')
  })

  /** ⚠ У ничьих звонков сотрудника нет вовсе — и объяснение у них своё, не «его нет в списке». */
  it('строка ничьих звонков объясняется иначе, чем чужая', async () => {
    const withNobody = buildActivityReport({
      users: [{ id: 1, name: 'Иванов Иван' }],
      totals: {},
      calls: aggregateCalls([{ PORTAL_USER_ID: '', CALL_TYPE: '1', CALL_DURATION: '0', CALL_FAILED_CODE: '304' }])
    })
    const wrapper = await mountSuspended(ActivityTable, { props: { report: withNobody } })
    expect(wrapper.text()).toContain('на общую линию')
    expect(wrapper.text()).not.toContain('нет в списке сотрудников портала')
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

  /**
   * ⚠ Порог 0 — это «считать все разговоры», и подпись обязана сказать именно так. «Разговор не
   * дольше 0 с» описывал бы порог, которого нет.
   */
  it('при отключённом пороге плитка коротких объясняет это словами', async () => {
    const base = report()
    const wrapper = await mountSuspended(ActivitySummary, {
      props: { report: { ...base, thresholdSeconds: 0 } }
    })
    expect(wrapper.text()).toContain('порог отключён')
    expect(wrapper.text()).not.toContain('не дольше 0 с')
  })

  /** ⚠ Созданные и закрытые лиды считаются по разным датам — плитка обязана это сказать. */
  it('плитка лидов объясняет, что закрытые считаются по дате закрытия', async () => {
    const wrapper = await mountSuspended(ActivitySummary, { props: { report: report() } })
    expect(wrapper.text()).toContain('закрыто за период')
  })
})

describe('ActivityTable: кликабельность чисел', () => {
  /**
   * Обёртка с инъекцией «во фрейме портала»: по устройству проекта компоненты про SDK не знают,
   * ответ приходит от страницы.
   */
  function inPortal(enabled: boolean, props: { report: ActivityReport }) {
    return defineComponent({
      setup() {
        provideDrillEnabled(computed(() => enabled))
        return () => h(ActivityTable, props)
      }
    })
  }

  it('во фрейме числа — кнопки со списком', async () => {
    const wrapper = await mountSuspended(inPortal(true, { report: report() }))
    const buttons = wrapper.findAll('button.drill-number')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.some(b => b.attributes('title')?.includes('Разговоры · Иванов Иван'))).toBe(true)
    expect(buttons.some(b => b.attributes('title')?.includes('Исходящие письма · Иванов Иван'))).toBe(true)
  })

  /**
   * ⚠ Вне портала детализации нет совсем: слайдера там не существует, а кнопка, которая заведомо
   * ничего не сделает, читается как поломка. ЧИСЛА при этом остаются — спрятать их значило бы
   * соврать.
   */
  it('вне портала кнопок нет, а числа остаются', async () => {
    const wrapper = await mountSuspended(inPortal(false, { report: report() }))
    expect(wrapper.findAll('button.drill-number')).toHaveLength(0)
    expect(wrapper.text()).toContain('12')
  })

  /** ⚠ Итоги некликабельны: это сумма показанных сотрудников, а не портальный запрос. */
  it('итоговая строка не кликабельна', async () => {
    const wrapper = await mountSuspended(inPortal(true, { report: report() }))
    const foot = wrapper.find('tfoot')
    expect(foot.findAll('button')).toHaveLength(0)
    expect(foot.text()).toContain('Итого')
  })

  /** ⚠ За длительностью стоит не «столько записей», а сумма секунд: списка у неё нет. */
  it('длительность и средний разговор не кликабельны', async () => {
    const wrapper = await mountSuspended(inPortal(true, { report: report() }))
    const titles = wrapper.findAll('button.drill-number').map(b => b.attributes('title') ?? '')
    expect(titles.some(t => t.includes('Наговорил'))).toBe(false)
    expect(titles.some(t => t.includes('Средний'))).toBe(false)
  })

  /** ⚠ У строки, которой дел не спрашивали, кликабельны только звонки. */
  it('чужой строке дают список только по звонкам', async () => {
    const wrapper = await mountSuspended(inPortal(true, { report: report() }))
    const titles = wrapper.findAll('button.drill-number').map(b => b.attributes('title') ?? '')
    expect(titles.some(t => t.includes('Разговоры · Сотрудник #7'))).toBe(true)
    expect(titles.some(t => t.includes('письма · Сотрудник #7'))).toBe(false)
  })

  /** Клик наверх едет строкой, видом числа и самим числом — из них страница соберёт условие. */
  it('клик отдаёт наверх строку, вид числа и число', async () => {
    const picks: unknown[] = []
    const wrapper = await mountSuspended(defineComponent({
      setup() {
        provideDrillEnabled(computed(() => true))
        return () => h(ActivityTable, {
          report: report(),
          onDrill: (payload: unknown) => { picks.push(payload) }
        })
      }
    }))
    const button = wrapper.findAll('button.drill-number')
      .find(b => b.attributes('title') === 'Исходящие письма · Иванов Иван')
    await button!.trigger('click')
    expect(picks).toHaveLength(1)
    expect(picks[0]).toMatchObject({
      cell: { kind: 'deed', deed: 'email', direction: 'out' },
      total: 12
    })
  })

  /**
   * ⚠ Пока звонки не прочитаны, их числа неизвестны — кнопки быть не должно: список открылся бы
   * по условию, для которого на экране стоит прочерк.
   */
  it('непрочитанные звонки не кликабельны', async () => {
    const wrapper = await mountSuspended(inPortal(true, { report: report({ withCalls: false }) }))
    const titles = wrapper.findAll('button.drill-number').map(b => b.attributes('title') ?? '')
    expect(titles.some(t => t.includes('Разговоры'))).toBe(false)
    // Дела при этом уже посчитаны и кликабельны.
    expect(titles.some(t => t.includes('Исходящие письма'))).toBe(true)
  })
})
