// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ManagersPage from '~/pages/app/managers.vue'
import HomePage from '~/pages/app/index.vue'

/**
 * Страницы приложения вне портала: главная (выбор отчёта) и отчёт «Сделки по менеджерам».
 *
 * ⚠ Снаружи портала отчёт показывает демонстрационный набор — и обязан сказать об этом раньше,
 * чем человек прочитает числа. Проверяем именно это, а не вёрстку.
 */
mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => false,
  targetOrigin: () => '?',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  openPath: async () => false,
  getOrThrow: () => {
    throw new Error('вне портала')
  }
}))

/** Гейт пускает страницу только с `?preview=1` — как в жизни. */
mockNuxtImport('useRoute', () => () => ({ query: { preview: '1' }, path: '/app/managers' }))

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await nextTick()
}

describe('страница «Сделки по менеджерам» вне портала', () => {
  it('показывает демо-набор и говорит, что это НЕ данные портала', async () => {
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    const text = wrapper.text()
    expect(text).toContain('Это НЕ данные вашего портала')
    expect(text).toContain('Сделки по менеджерам')
    // Матрица построена: офис демо-набора и его менеджеры на экране.
    expect(text).toContain('Минск')
    expect(text).toContain('Итого по офису')
  })

  it('в шапке есть переход на второй отчёт и на главную', async () => {
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    const links = wrapper.findAll('a').map(a => ({ href: a.attributes('href'), text: a.text() }))
    expect(links.some(link => link.text === 'Аналитика по лидам')).toBe(true)
    expect(links.some(link => link.text === 'Все отчёты')).toBe(true)
    // ⚠ Запрос сохраняется: без `?preview=1` соседний отчёт встретил бы заглушкой.
    expect(links.every(link => (link.href ?? '').includes('preview=1'))).toBe(true)
  })

  it('сводка над таблицей называет охват словами', async () => {
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    const text = wrapper.text()
    expect(text).toContain('Сделок')
    expect(text).toContain('Менеджеров')
    expect(text).toContain('Офисов')
  })
})

describe('главная страница приложения', () => {
  it('перечисляет оба отчёта и ведёт на них', async () => {
    const wrapper = await mountSuspended(HomePage)
    await flush()
    const text = wrapper.text()
    expect(text).toContain('Аналитика по лидам')
    expect(text).toContain('Сделки по менеджерам')
    const links = wrapper.findAll('a').map(a => a.attributes('href') ?? '')
    expect(links.some(href => href.startsWith('/app/leads'))).toBe(true)
    expect(links.some(href => href.startsWith('/app/managers'))).toBe(true)
  })

  it('вне портала честно говорит, где живут живые данные', async () => {
    const wrapper = await mountSuspended(HomePage)
    await flush()
    expect(wrapper.text()).toContain('Страница открыта вне портала')
  })
})
