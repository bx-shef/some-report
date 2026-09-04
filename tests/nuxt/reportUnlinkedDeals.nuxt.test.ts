// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportUnlinkedDeals from '~/components/ReportUnlinkedDeals.vue'
import type { UnlinkedDeals } from '~/types/report'
import { UNSPECIFIED_SOURCE } from '~/utils/metrics'
import { nbsp } from '../helpers/text'

/**
 * Блок про факт, который отчёт обязан предъявить, а не спрятать: 90 % успешных сделок закрыты
 * мимо лидов. Колонки «сделок» и «сумма» с их долями — числа-тёзки: перепутанные местами их не
 * поймает ни тайпчекер, ни проверка по сплошному тексту. Поэтому проверяем ячейки.
 */
const dictionaries = { sources: { CALL: 'Звонок' }, junkReasons: {}, lossReasons: {} }

const august: UnlinkedDeals = {
  total: 5536,
  revenue: 1_234_500,
  unconverted: 0,
  rows: [
    { sourceId: UNSPECIFIED_SOURCE, count: 5531, share: 0.999, revenue: 1_230_000, shareOfRevenue: 0.996 },
    { sourceId: 'CALL', count: 5, share: 0.001, revenue: 4_500, shareOfRevenue: 0.004 }
  ]
}

function render(props: Partial<{ unlinked: UnlinkedDeals, pending: boolean, error: string }> = {}) {
  return mountSuspended(ReportUnlinkedDeals, {
    props: { unlinked: august, pending: false, dictionaries, currencyId: 'BYN', ...props }
  })
}

describe('ReportUnlinkedDeals', () => {
  it('говорит, по какой дате период и что в воронку эти сделки не входят', async () => {
    const text = (await render()).text()
    expect(text).toContain('по дате закрытия')
    expect(text).toContain('в воронку и выручку по лидам не входят')
  })

  it('оранжевая плашка про интернет-магазин есть всегда — и пока считаем, и когда посчитали', async () => {
    expect((await render()).text()).toContain('Заказы из интернет-магазина лид не порождают')
    expect((await render({ pending: true })).text()).toContain('Заказы из интернет-магазина лид не порождают')
  })

  it('пока идёт фоновая выборка — говорит об этом, таблицы нет', async () => {
    const wrapper = await render({ pending: true, unlinked: undefined })
    expect(wrapper.text()).toContain('Считаем успешные сделки без лида')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('ошибка выборки — своя плашка, остальной отчёт не при чём', async () => {
    const wrapper = await render({ error: 'нет доступа', unlinked: undefined })
    expect(wrapper.text()).toContain('Не удалось прочитать сделки без лида')
    expect(wrapper.text()).toContain('нет доступа')
  })

  it('печатает итог и сумму в шапке', async () => {
    const text = nbsp((await render()).text())
    expect(text).toContain('5 536')
    expect(text).toContain('1 234 500')
  })

  it('остаток называет прямо, а не «другими источниками»', async () => {
    const text = (await render()).text()
    expect(text).toContain('Источник не указан')
    expect(text).not.toContain('Другие источники')
    expect(text).toContain('Звонок')
  })

  it('числа стоят в своих колонках: сделок, доля, сумма, доля суммы', async () => {
    const wrapper = await render()
    const first = wrapper.findAll('tbody tr')[0]!.findAll('td').map(td => nbsp(td.text()))
    expect(first[0]).toContain('Источник не указан')
    expect(first[1]).toBe('5 531')
    expect(first[2]).toBe('99,9 %')
    expect(first[3]).toContain('1 230 000')
    expect(first[4]).toBe('99,6 %')
    const foot = wrapper.find('tfoot').findAll('td').map(td => nbsp(td.text()))
    expect(foot[1]).toBe('5 536')
    expect(foot[3]).toContain('1 234 500')
  })

  it('сделки без курса — оговорка с числом', async () => {
    const text = (await render({ unlinked: { ...august, unconverted: 3 } })).text()
    expect(text).toContain('без курса')
    expect(text).toContain('3')
  })

  it('без сделок без лида говорит об этом словами, а не пустой таблицей', async () => {
    const wrapper = await render({ unlinked: { total: 0, revenue: 0, unconverted: 0, rows: [] } })
    expect(wrapper.text()).toContain('успешных сделок без лида нет')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})
