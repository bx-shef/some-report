// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import App from '~/app.vue'
import { usePaymentLockHardFrom, usePaymentLockReleased, usePaymentLockResolved, usePaymentLockStage } from '~/composables/usePaymentLock'

/**
 * Корень приложения: что он рисует и в каком порядке спрашивает.
 *
 * ⛔ Сторожит два решения, каждое из которых уже было сломано и ни одно из которых не видно по
 * экрану. Первое: страница не монтируется, пока решение о блокировке не принято, — иначе отчёт
 * успевает сходить в CRM, а главная приложения сжечь одноразовое условие детализации. Второе:
 * строка запроса читается ТОЛЬКО после готовности роутера.
 */
const portal = vi.hoisted(() => ({
  path: '/app/leads',
  /** Что отдаёт роутер ДО готовности: начальная навигация ещё не разобрала адрес. */
  queryBefore: {} as Record<string, unknown>,
  /** И что — после. Разница между ними и есть предмет проверки. */
  queryAfter: {} as Record<string, unknown>,
  ready: false,
  config: { softFrom: '', hardFrom: '', off: '' } as Record<string, string>
}))

mockNuxtImport('useRoute', () => () => ({
  get path() {
    return portal.path
  },
  get query() {
    return portal.ready ? portal.queryAfter : portal.queryBefore
  }
}))

/**
 * Роутер НЕ подменяется, а оборачивается.
 *
 * ⚠ Тонкая заглушка с одним `isReady` роняет тест целиком: `useRouter()` зовут и внутренние
 * плагины Nuxt, и им нужен настоящий роутер (`router.beforeResolve is not a function`). Поэтому
 * берём живой и добавляем к нему только отметку «готовность спросили».
 */
mockNuxtImport('useRouter', () => () => {
  const real = useNuxtApp().$router
  return Object.assign(Object.create(real), {
    isReady: async () => {
      portal.ready = true
      await real.isReady()
    }
  })
})

registerEndpoint('/payment-lock.json', () => portal.config)

/** Заглушка страницы: её присутствие в разметке и есть ответ «страницу смонтировали». */
const PageStub = defineComponent({ setup: () => () => h('div', { 'data-testid': 'страница' }, 'отчёт') })

async function mountApp() {
  const wrapper = await mountSuspended(App, { global: { stubs: { NuxtPage: PageStub } } })
  await vi.waitFor(() => expect(usePaymentLockResolved().value).toBe(true))
  await nextTick()
  return wrapper
}

beforeEach(() => {
  portal.path = '/app/leads'
  portal.queryBefore = {}
  portal.queryAfter = {}
  portal.ready = false
  portal.config = { softFrom: '', hardFrom: '', off: '' }
  usePaymentLockStage().value = 'none'
  usePaymentLockHardFrom().value = undefined
  usePaymentLockResolved().value = false
  usePaymentLockReleased().value = false
})

describe('корень приложения и блокировка', () => {
  it('без блокировки показывает страницу', async () => {
    const wrapper = await mountApp()
    expect(wrapper.find('[data-testid="страница"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="payment-lock"]').exists()).toBe(false)
  })

  /**
   * ⛔ Главная проверка. Страница НЕ должна появиться на экране ни на мгновение: её монтирование —
   * это поход в CRM и чтение одноразового условия детализации, а при жёсткой блокировке ни того,
   * ни другого быть не должно.
   */
  it('при блокировке страницу не монтирует вовсе', async () => {
    portal.config = { softFrom: '2020-01-01', hardFrom: '2020-01-01', off: '' }
    const wrapper = await mountApp()
    expect(wrapper.find('[data-testid="payment-lock"]').attributes('data-stage')).toBe('hard')
    expect(wrapper.find('[data-testid="страница"]').exists()).toBe(false)
  })

  /**
   * ⛔ И вторая половина того же решения: пока решение НЕ ПРИНЯТО, на экране пусто. Отрисуй мы
   * страницу «пока думаем», она успела бы сделать ровно то, ради предотвращения чего всё и затеяно.
   */
  it('до решения не рисует ни страницу, ни экран', async () => {
    const wrapper = await mountSuspended(App, { global: { stubs: { NuxtPage: PageStub } } })
    expect(usePaymentLockResolved().value).toBe(false)
    expect(wrapper.find('[data-testid="страница"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="payment-lock"]').exists()).toBe(false)
  })

  /**
   * ⛔ Обход `?lock=` читается ТОЛЬКО после готовности роутера.
   *
   * Стенд отдаёт пустой запрос до `isReady()` и настоящий после — ровно так ведёт себя сборка:
   * пока страница монтировалась сразу, `onMounted` корня выполнялся после детей и роутер успевал
   * разобрать адрес; теперь детей нет, корень монтируется мгновенно и видит пустой `route.query`.
   * Убери ожидание — и обход молча перестанет работать, а выглядеть это будет как «экран
   * показывает не ту стадию».
   */
  it('обход из адреса читается после готовности роутера, а не раньше', async () => {
    portal.queryAfter = { lock: 'hard' }
    const wrapper = await mountApp()
    expect(wrapper.find('[data-testid="payment-lock"]').attributes('data-stage')).toBe('hard')
  })

  /**
   * ⚠ Установщик не блокируется, и решение по нему известно СИНХРОННО — иначе в статику запеклась
   * бы пустая страница установки, а её портал открывает сам.
   */
  it('на установщике страница рисуется сразу, без ожидания сервера', async () => {
    portal.path = '/install'
    const wrapper = await mountSuspended(App, { global: { stubs: { NuxtPage: PageStub } } })
    expect(usePaymentLockResolved().value).toBe(true)
    expect(wrapper.find('[data-testid="страница"]').exists()).toBe(true)
  })
})
