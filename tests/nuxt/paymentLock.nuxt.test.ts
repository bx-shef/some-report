// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import PaymentLockScreen from '~/components/PaymentLockScreen.vue'
import { usePaymentLock } from '~/composables/usePaymentLock'
import { LOCK_RELEASE_SECONDS } from '~/utils/paymentLock'

/**
 * Блокировка приложения при неподписанных актах — живой путь целиком: настройки приезжают С
 * СЕРВЕРА, складываются с обходом из адреса и превращаются в экран.
 *
 * ⚠ Даты здесь ЗАВЕДОМО прошлые и заведомо далёкие будущие, а не «через неделю». Дата «через
 * неделю» превращает тест в бомбу замедленного действия: он зеленеет сегодня и начинает проверять
 * другую ветку через семь дней, никого об этом не предупредив.
 */
const PAST = '2020-01-01'
const FAR_FUTURE = '2999-01-01'

const portal = vi.hoisted(() => ({
  /** Путь и строка запроса текущей страницы. */
  route: { path: '/app/leads', query: {} as Record<string, unknown> },
  /** Что отвечает сервер на запрос настроек. `null` — отвечает отказом. */
  config: null as Record<string, string> | null,
  /** Сколько раз у сервера вообще спросили настройки. */
  asked: 0
}))

mockNuxtImport('useRoute', () => () => portal.route)

registerEndpoint('/payment-lock.json', () => {
  portal.asked++
  // ⚠ Отказ сервера обязан проверяться настоящим отказом, а не пустым ответом: это разные ветки,
  // и «блокировки нет» должно получаться в обеих.
  if (!portal.config) throw new Error('сервер настроек недоступен')
  return portal.config
})

/** Хозяин композабла: в приложении его зовёт `app.vue`, здесь — этот компонент. */
const Host = defineComponent({
  setup() {
    const lock = usePaymentLock()
    return () => h('div', { 'data-stage': lock.stage.value, 'data-blocking': String(lock.blocking.value) }, [
      h('span', { 'data-testid': 'remaining' }, String(lock.remaining.value)),
      h('span', { 'data-testid': 'hard-from' }, lock.hardFrom.value ?? '')
    ])
  }
})

/**
 * Смонтировать хозяина и ДОЖДАТЬСЯ, пока настройки доедут и превратятся в стадию.
 *
 * ⚠ Ожидание здесь дважды переписывалось, и оба прежних варианта были ложными проверками.
 * Первый ждал появления атрибута — а он нарисован с первого кадра, так что ожидание кончалось
 * мгновенно. Второй крутил `nextTick` — а ответ `$fetch` доезжает МАКРОзадачей, и `nextTick`,
 * который крутит только микрозадачи, её не дожидается: проба показала шесть тактов подряд со
 * стадией ДО ответа. Отсюда уступка такта планировщику, а не ещё десяток `nextTick`.
 */
async function mountLock(expected: 'none' | 'soft' | 'hard') {
  const wrapper = await mountSuspended(Host)
  if (portal.route.path.startsWith('/app')) {
    await vi.waitFor(() => expect(portal.asked).toBeGreaterThan(0))
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  await vi.waitFor(() => expect(wrapper.attributes('data-stage')).toBe(expected))
  return wrapper
}

beforeEach(() => {
  portal.route = { path: '/app/leads', query: {} }
  portal.config = null
  portal.asked = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('расписание приезжает с сервера', () => {
  /** ⛔ Главный сценарий: напоминание показалось и САМО пропустило дальше. */
  it('мягкая стадия держит экран и снимается через положенные секунды', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    portal.config = { softFrom: PAST, hardFrom: FAR_FUTURE, off: '' }
    const wrapper = await mountLock('soft')

    expect(wrapper.attributes('data-blocking')).toBe('true')
    expect(wrapper.get('[data-testid="hard-from"]').text()).toBe(FAR_FUTURE)

    await vi.advanceTimersByTimeAsync(LOCK_RELEASE_SECONDS * 1000 + 600)
    await nextTick()
    expect(wrapper.attributes('data-blocking')).toBe('false')
  })

  /** ⛔ И обратный: жёсткую стадию не снимает ничто, сколько ни жди. */
  it('жёсткая стадия не снимается со временем', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    portal.config = { softFrom: PAST, hardFrom: PAST, off: '' }
    const wrapper = await mountLock('hard')

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await nextTick()
    expect(wrapper.attributes('data-blocking')).toBe('true')
  })

  it('рубильник снимает блокировку при живых датах', async () => {
    portal.config = { softFrom: PAST, hardFrom: PAST, off: '1' }
    await mountLock('none')
  })

  /**
   * ⛔ Отказ сервера уводит В СТОРОНУ РАБОТАЮЩЕГО отчёта. Запереть оплатившего клиента из-за своей
   * же неполадки хуже, чем не показать напоминание: напоминание вернётся завтра, рабочий день — нет.
   */
  it('сервер не ответил — приложение работает', async () => {
    portal.config = null
    await mountLock('none')
    expect(portal.asked).toBeGreaterThan(0)
  })

  it('пустые настройки — это «блокировки нет»', async () => {
    portal.config = { softFrom: '', hardFrom: '', off: '' }
    await mountLock('none')
  })
})

describe('область действия и обход из адреса', () => {
  /**
   * ⛔ Установщик не блокируется, и сервер о нём даже не спрашивается: через `/install` портал
   * ПЕРЕставляет приложение — заблокируй его, и чинить на портале клиента станет нечем, в том
   * числе снимать саму блокировку.
   */
  it('на установщике настроек не спрашивают вовсе', async () => {
    portal.route = { path: '/install', query: {} }
    portal.config = { softFrom: PAST, hardFrom: PAST, off: '' }
    const wrapper = await mountLock('none')
    expect(portal.asked).toBe(0)
    expect(wrapper.attributes('data-blocking')).toBe('false')
  })

  /** Ради этого обход и заведён: посмотреть экран до наступления даты. */
  it('?lock=hard показывает экран при пустом расписании', async () => {
    portal.route = { path: '/app/leads', query: { lock: 'hard' } }
    portal.config = { softFrom: '', hardFrom: '', off: '' }
    await mountLock('hard')
  })

  /**
   * ⛔ И то, ради чего обход умеет только ПОВЫШАТЬ: `?lock=soft` в день жёсткой блокировки не
   * понижает её до отсчёта. Иначе ссылка из адресной строки стала бы ключом от блокировки.
   */
  it('?lock=soft не понижает жёсткую блокировку', async () => {
    portal.route = { path: '/app/leads', query: { lock: 'soft' } }
    portal.config = { softFrom: PAST, hardFrom: PAST, off: '' }
    await mountLock('hard')
  })
})

describe('экран блокировки', () => {
  it('напоминание называет срок и показывает отсчёт', async () => {
    const wrapper = await mountSuspended(PaymentLockScreen, {
      props: { stage: 'soft' as const, remaining: 7, hardFrom: '2026-09-21' }
    })
    expect(wrapper.get('[data-testid="payment-lock"]').attributes('data-stage')).toBe('soft')
    expect(wrapper.get('[data-testid="payment-lock-countdown"]').text()).toContain('7 секунд')
    expect(wrapper.get('[data-testid="payment-lock-deadline"]').text()).toContain('21.09.2026')
  })

  /**
   * ⚠ Срок без даты на сервере не выдумывается. Строка «приложение перестанет открываться» без
   * числа — обещание, которое некому подтвердить, и читается она как пустая угроза.
   */
  it('без даты на сервере строки про срок нет', async () => {
    const wrapper = await mountSuspended(PaymentLockScreen, {
      props: { stage: 'soft' as const, remaining: 20 }
    })
    expect(wrapper.find('[data-testid="payment-lock-deadline"]').exists()).toBe(false)
  })

  /** У отказа отсчёта нет: показывать «осталось 20 секунд» там, где ничего не откроется, — ложь. */
  it('отказ не показывает отсчёт и обещает не открыться', async () => {
    const wrapper = await mountSuspended(PaymentLockScreen, {
      props: { stage: 'hard' as const, remaining: 20, hardFrom: '2026-09-21' }
    })
    expect(wrapper.get('[data-testid="payment-lock"]').attributes('data-stage')).toBe('hard')
    expect(wrapper.find('[data-testid="payment-lock-countdown"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="payment-lock-deadline"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Приложение остановлено')
  })
})
