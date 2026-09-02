// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DonutChart from '~/components/DonutChart.vue'

const items = [
  { key: 'a', label: 'Нецелевой запрос', value: 90, color: 'var(--chart-1)' },
  { key: 'b', label: 'Дубль обращения', value: 80, color: 'var(--chart-3)' }
]

describe('DonutChart', () => {
  it('рисует по сектору на причину', async () => {
    const wrapper = await mountSuspended(DonutChart, { props: { items } })
    expect(wrapper.findAll('path')).toHaveLength(2)
  })

  // Идентичность сектора не должна держаться на одном цвете: у каждого есть <title> для
  // скринридера и подсказки, а рядом с диаграммой — легенда и таблица.
  it('каждому сектору даёт текстовую подпись', async () => {
    const wrapper = await mountSuspended(DonutChart, { props: { items } })
    expect(wrapper.findAll('title').map(t => t.text())).toEqual(['Нецелевой запрос', 'Дубль обращения'])
  })

  // Пустое кольцо вместо текста «нет данных»: блок сохраняет размер, и таблица под ним не прыгает.
  it('без данных показывает пустое кольцо, а не пустоту', async () => {
    const wrapper = await mountSuspended(DonutChart, { props: { items: [] } })
    expect(wrapper.findAll('path')).toHaveLength(0)
    expect(wrapper.find('circle').exists()).toBe(true)
  })

  it('печатает число в центре кольца', async () => {
    const wrapper = await mountSuspended(DonutChart, {
      props: { items, centerValue: '250', centerLabel: 'лидов' }
    })
    expect(wrapper.text()).toContain('250')
    expect(wrapper.text()).toContain('лидов')
  })
})
