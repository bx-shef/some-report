// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ManagersPage from '~/pages/app/managers.vue'
import HomePage from '~/pages/app/index.vue'
import { APP_REPORTS } from '~/config/routes'

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
    // Матрица построена: компания демо-набора и его менеджеры на экране.
    expect(text).toContain('Минск')
    expect(text).toContain('Итого по компании')
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

  // Блок «Распределение»: крупная диаграмма и столбик чисел рядом — как в прежнем отчёте
  // заказчика. Проверяем, что он на экране и что числа подписаны словами.
  it('над таблицей — диаграмма распределения и статистика', async () => {
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    const text = wrapper.text()
    expect(text).toContain('Распределение')
    expect(text).toContain('Сделок')
    expect(text).toContain('Менеджеров')
    expect(text).toContain('Стадий')
    // ⚠ Плитки «Без ответственного» на экране НЕТ: ответственный у сделки обязателен, и она
    // всегда показывала ноль (решение владельца 2026-09-06).
    //
    // ⚠ Сравнение именно в том регистре, что лежит в DOM. `uppercase` в разметке — это CSS
    // `text-transform`, до `textContent` он не доходит: проверка заглавными была зелёной и с
    // возвращённой плиткой, то есть не сторожила ровно то, ради чего написана.
    expect(text).not.toContain('Без ответственного')
    expect(wrapper.findAll('svg path').length).toBeGreaterThan(0)
  })

  /**
   * ⚠ Вне портала детализации нет совсем (решение владельца от 2026-09-06): список открывает
   * настоящий слайдер Битрикс24, а вне фрейма его не существует. Числа обязаны остаться ТЕКСТОМ:
   * кнопка, которая заведомо ничего не сделает, читается как поломка отчёта.
   *
   * ⚠ Проверяем это на ОБОИХ носителях чисел — таблице и кольце: кликабельность в них написана
   * четырьмя отдельными местами разметки, и погаснуть она может не везде сразу.
   */
  it('вне портала числа матрицы и кольца — не кнопки', async () => {
    const wrapper = await mountSuspended(ManagersPage)
    await flush()
    const drillButtons = wrapper.findAll('button')
      .filter(b => (b.attributes('title') ?? '').startsWith('Открыть список'))
    expect(drillButtons).toHaveLength(0)
    // Сторож самой проверки: числа при этом на экране, просто не кнопки.
    expect(wrapper.text()).toContain('Итого по компании')
  })
})

describe('главная страница приложения', () => {
  /**
   * ⚠ Перечисляем отчёты ИЗ `APP_REPORTS`, а не поимённо. Прежняя редакция называла два отчёта
   * буквально и осталась зелёной, когда отчётов стало три: четвёртый забыли бы на плитке ровно
   * так же — тихо, при исправной сборке. Главная приложения — единственный вход туда, куда не
   * ведёт пункт меню.
   */
  it('перечисляет ВСЕ отчёты и ведёт на каждый', async () => {
    const wrapper = await mountSuspended(HomePage)
    await flush()
    const text = wrapper.text()
    const links = wrapper.findAll('a').map(a => a.attributes('href') ?? '')
    for (const report of APP_REPORTS) {
      expect(text).toContain(report.title)
      expect(links.some(href => href.startsWith(report.path))).toBe(true)
    }
    // Сторож самой проверки: пустой список отчётов сделал бы цикл выше пустым и зелёным.
    expect(APP_REPORTS.length).toBeGreaterThanOrEqual(3)
  })

  it('вне портала честно говорит, где живут живые данные', async () => {
    const wrapper = await mountSuspended(HomePage)
    await flush()
    expect(wrapper.text()).toContain('Страница открыта вне портала')
  })
})
