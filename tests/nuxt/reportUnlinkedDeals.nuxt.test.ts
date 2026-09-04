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
  totalShareOfRevenue: 1,
  rows: [
    { sourceId: UNSPECIFIED_SOURCE, count: 5531, share: 0.999, revenue: 1_230_000, shareOfRevenue: 0.996 },
    { sourceId: 'CALL', count: 5, share: 0.001, revenue: 4_500, shareOfRevenue: 0.004 }
  ]
}

function render(props: Partial<{ unlinked: UnlinkedDeals, pending: boolean, deferred: boolean, error: string, estimateMinutes: number, filtered: boolean }> = {}) {
  return mountSuspended(ReportUnlinkedDeals, {
    props: { unlinked: august, pending: false, deferred: false, estimateMinutes: 1, dictionaries, currencyId: 'BYN', ...props }
  })
}

describe('ReportUnlinkedDeals', () => {
  it('говорит, по какой дате период и что в воронку эти сделки не входят', async () => {
    const text = (await render()).text()
    expect(text).toContain('по дате закрытия')
    expect(text).toContain('в воронку и выручку по лидам не входят')
  })

  // Решение владельца: фильтры отчёта на блок не действуют. Без подписи отфильтрованная воронка
  // над полным блоком читалась бы как ошибка.
  it('под фильтрами отчёта говорит, что здесь они не действуют', async () => {
    expect((await render({ filtered: true })).text()).toContain('Фильтры отчёта здесь не действуют')
    expect((await render()).text()).not.toContain('Фильтры отчёта здесь не действуют')
  })

  it('оранжевая плашка про интернет-магазин есть всегда — и пока считаем, и когда посчитали', async () => {
    expect((await render()).text()).toContain('Заказы из интернет-магазина лид не порождают')
    expect((await render({ pending: true })).text()).toContain('Заказы из интернет-магазина лид не порождают')
  })

  it('пока идёт фоновая выборка — говорит об этом и о времени по длине периода, таблицы нет', async () => {
    const wrapper = await render({ pending: true, unlinked: undefined, estimateMinutes: 12 })
    expect(wrapper.text()).toContain('Считаем успешные сделки без лида')
    expect(wrapper.text()).toContain('примерно 12 мин')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  // ⚠ Год — минут двенадцать выборки. От случайного клика такое не стартует: кнопка и оценка.
  it('на длинном периоде — кнопка «Посчитать» с оценкой, таблицы и индикатора нет', async () => {
    const wrapper = await render({ deferred: true, unlinked: undefined, estimateMinutes: 12 })
    expect(wrapper.text()).toContain('примерно 12 мин')
    expect(wrapper.text()).not.toContain('Считаем')
    expect(wrapper.find('table').exists()).toBe(false)
    const button = wrapper.findAll('button').find((b: { text: () => string }) => b.text().includes('Посчитать'))!
    await button.trigger('click')
    expect(wrapper.emitted('start')).toHaveLength(1)
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
    const text = (await render({ unlinked: { ...august, unconverted: 42 } })).text()
    expect(text).toContain('без курса')
    expect(text).toContain('42')
    expect((await render()).text()).not.toContain('без курса')
  })

  it('подвал доли суммы берёт из данных: при нулевой сумме — 0 %', async () => {
    const zero: UnlinkedDeals = { ...august, revenue: 0, totalShareOfRevenue: 0, rows: [{ ...august.rows[0]!, revenue: 0, shareOfRevenue: 0 }] }
    const foot = (await render({ unlinked: zero })).find('tfoot').findAll('td').map(td => nbsp(td.text()))
    expect(foot[4]).toBe('0 %')
  })

  it('без сделок без лида говорит об этом словами, а не пустой таблицей', async () => {
    const wrapper = await render({ unlinked: { total: 0, revenue: 0, unconverted: 0, totalShareOfRevenue: 0, rows: [] } })
    expect(wrapper.text()).toContain('успешных сделок без лида нет')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  // «Источник не указан» — остаток арифметики, списка «тем же условием» за ним нет: не кнопка.
  it('число источника — кнопка списка без лида по источнику; «не указан» — просто число', async () => {
    const wrapper = await render()
    const titles = wrapper.findAll('button').map((b: { attributes: (name: string) => string | undefined }) => b.attributes('title') ?? '')
    expect(titles.filter(t => t.startsWith('Открыть список: Успешные сделки без лида:'))).toEqual(['Открыть список: Успешные сделки без лида: Звонок'])
    const button = wrapper.findAll('button').find((b: { attributes: (name: string) => string | undefined }) => b.attributes('title') === 'Открыть список: Успешные сделки без лида: Звонок')!
    await button.trigger('click')
    expect(wrapper.emitted('drill')?.[0]?.[0]).toMatchObject({ entity: 'deal', dealScope: 'unlinked', extra: { SOURCE_ID: 'CALL' } })
    const total = wrapper.findAll('button').find((b: { attributes: (name: string) => string | undefined }) => b.attributes('title') === 'Открыть список: Успешные сделки без связи с лидом')!
    await total.trigger('click')
    expect(wrapper.emitted('drill')?.[1]?.[0]).toMatchObject({ dealScope: 'unlinked', extra: {} })
  })
})
