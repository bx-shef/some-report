// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import PaymentLockScreen from '~/components/PaymentLockScreen.vue'
import { resolvePaymentLock, usePaymentLock, usePaymentLockHardFrom, usePaymentLockReleased, usePaymentLockResolved, usePaymentLockStage } from '~/composables/usePaymentLock'
import { LOCK_RELEASE_SECONDS } from '~/utils/paymentLock'

/**
 * Приостановка приложения при незавершённом приёме работ — живой путь целиком: настройки приезжают С
 * СЕРВЕРА, складываются с обходом из адреса и превращаются в экран.
 *
 * ⚠ Даты здесь ЗАВЕДОМО прошлые и заведомо далёкие будущие, а не «через неделю». Дата «через
 * неделю» превращает тест в бомбу замедленного действия: он зеленеет сегодня и начинает проверять
 * другую ветку через семь дней, никого об этом не предупредив.
 */
const PAST = '2020-01-01'
const FAR_FUTURE = '2999-01-01'

const portal = vi.hoisted(() => ({
  /** Путь и значение `?lock` — ровно то, что отдаёт роутер. */
  pathname: '/app/leads',
  lockParam: undefined as unknown,
  /** Что отвечает сервер на запрос настроек. `null` — отвечает отказом. */
  config: null as Record<string, string> | null,
  /** Сколько раз у сервера вообще спросили настройки. */
  asked: 0
}))

registerEndpoint('/payment-lock.json', () => {
  portal.asked++
  // ⚠ Отказ сервера проверяется настоящим отказом, а не пустым ответом: это разные ветки, и
  // «блокировки нет» должно получаться в обеих.
  if (!portal.config) throw new Error('сервер настроек недоступен')
  return portal.config
})

/**
 * Обещание решения — чтобы тесту не приходилось гадать, когда сервер ответил.
 *
 * ⚠ Ожидание здесь дважды оказывалось ложной проверкой: сначала ждали появления атрибута (он
 * нарисован с первого кадра), потом крутили `nextTick` (ответ `$fetch` доезжает МАКРОзадачей).
 * Оба раза тесты видели состояние ДО ответа и зеленели во всех ветках сразу. Теперь ждать нечего:
 * берём то самое обещание, которое возвращает `resolvePaymentLock`.
 */
let decided: Promise<void>

/**
 * Снимок общего состояния «отсчёт отсижен», взятый ВНУТРИ приложения.
 *
 * ⚠ Нужен ровно для одной проверки — что размонтированный отсчёт больше ничего не трогает.
 * Проверять это счётчиком таймеров нельзя: он считает и чужие (например, таймаут запроса), и
 * покраснел бы от постороннего.
 */
let releasedOutside: Ref<boolean>

/**
 * Приложение — в точности как `app/app.vue`: состояние читается СИНХРОННО в setup, а решение
 * принимается в `onMounted`, уже после монтирования.
 *
 * ⚠ Синхронность setup здесь принципиальна, и это не стиль стенда. Хуки, зарегистрированные после
 * `await` в асинхронном setup, не цепляются ни за что: редакция, звавшая композабл после
 * ожидания, оставляла `onScopeDispose` без области видимости — таймер не снимался, и тест
 * «размонтирование останавливает отсчёт» краснел, обвиняя исправный код.
 */
const App = defineComponent({
  setup() {
    // ⚠ Состояние блокировки живёт в `useState`, то есть переживает размонтирование и утекло бы из
    // теста в тест: вторая проверка видела бы решение первой. Чистим ТОЧЕЧНО, свои три ключа:
    // `clearNuxtState()` стирает и чужое — на нём падал плагин темы b24ui, и падал не в тесте
    // блокировки, а где-то рядом, необъяснимо.
    usePaymentLockStage().value = 'none'
    usePaymentLockHardFrom().value = undefined
    usePaymentLockResolved().value = false
    usePaymentLockReleased().value = false
    releasedOutside = usePaymentLockReleased()
    const lock = usePaymentLock(portal.pathname)
    onMounted(() => {
      decided = resolvePaymentLock(portal.pathname, portal.lockParam)
    })
    return () => h('div', { 'data-stage': lock.stage.value, 'data-blocking': String(lock.blocking.value) }, [
      h('span', { 'data-testid': 'remaining' }, String(lock.remaining.value)),
      h('span', { 'data-testid': 'hard-from' }, lock.hardFrom.value ?? '')
    ])
  }
})

/**
 * Смонтированные приложения — чтобы убрать их за собой.
 *
 * ⛔ Не гигиена ради гигиены. Состояние блокировки общее (`useState`), а отсчёт живёт в таймере:
 * приложение, оставшееся смонтированным после своего теста, продолжает тикать и снимает блокировку
 * СОСЕДНЕМУ тесту. Именно так и случилось — проверка «размонтирование останавливает отсчёт» падала
 * от чужого таймера при совершенно исправном коде.
 */
const mounted: { unmount: () => void }[] = []

/** Смонтировать приложение и дождаться решения — ровно того же обещания, что и в бою. */
async function mountApp() {
  const wrapper = await mountSuspended(App)
  mounted.push(wrapper)
  await decided
  await nextTick()
  return wrapper
}

beforeEach(() => {
  portal.pathname = '/app/leads'
  portal.lockParam = undefined
  portal.config = null
  portal.asked = 0
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
})

describe('расписание приезжает с сервера', () => {
  /** ⛔ Главный сценарий: напоминание показалось и САМО пропустило дальше. */
  it('мягкая стадия держит экран и снимается через положенные секунды', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    portal.config = { softFrom: PAST, hardFrom: FAR_FUTURE, off: '' }
    const wrapper = await mountApp()

    expect(wrapper.attributes('data-stage')).toBe('soft')
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
    const wrapper = await mountApp()

    expect(wrapper.attributes('data-stage')).toBe('hard')
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await nextTick()
    expect(wrapper.attributes('data-blocking')).toBe('true')
  })

  /**
   * ⛔ Таймер обязан сниматься вместе с компонентом.
   *
   * `onScopeDispose` регистрируется СИНХРОННО, в setup: внутри асинхронного хука он вызвался бы
   * уже после первого `await`, когда активной области видимости эффектов нет, и не зацепился бы ни
   * за что. Прежде единственным следом этого была строка предупреждения в выводе теста — то есть
   * сторожила дефект внимательность читающего вывод, а не проверка.
   */
  it('размонтирование останавливает отсчёт, а не оставляет его тикать', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    portal.config = { softFrom: PAST, hardFrom: FAR_FUTURE, off: '' }
    const wrapper = await mountApp()
    expect(wrapper.attributes('data-stage')).toBe('soft')
    expect(releasedOutside.value).toBe(false)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(LOCK_RELEASE_SECONDS * 1000 + 600)
    // ⚠ Проверяется ПОСЛЕДСТВИЕ, а не наличие таймера: уцелевший отсчёт снял бы общую блокировку
    // у уже закрытой страницы — то есть пустил бы в портал того, кого экран держать обязан.
    expect(releasedOutside.value).toBe(false)
  })

  it('рубильник снимает блокировку при живых датах', async () => {
    portal.config = { softFrom: PAST, hardFrom: PAST, off: '1' }
    expect((await mountApp()).attributes('data-stage')).toBe('none')
  })

  /**
   * ⛔ Отказ сервера уводит В СТОРОНУ РАБОТАЮЩЕГО отчёта. Запереть оплатившего клиента из-за своей
   * же неполадки хуже, чем не показать напоминание: напоминание вернётся завтра, рабочий день — нет.
   *
   * ⚠ С обходом `?lock=hard`, и это НЕ украшение сценария. Прежде тест ждал стадию `none` — то
   * есть ровно то значение, с которого стадия и начинается. Проверка тестов PR саботировала код,
   * убрав `try/catch` вокруг запроса: исключение обрывало выполнение ДО присвоения стадии, стадия
   * оставалась `none`, и все тесты файла остались зелёными. Теперь после отказа код обязан ДОЙТИ
   * до присвоения — иначе `hard` не появится, и тест покраснеет по-настоящему.
   */
  it('сервер не ответил — приложение работает, а решение всё равно принимается', async () => {
    portal.config = null
    portal.lockParam = 'hard'
    const wrapper = await mountApp()
    expect(portal.asked).toBeGreaterThan(0)
    expect(wrapper.attributes('data-stage')).toBe('hard')
  })

  it('пустые настройки — это «блокировки нет»', async () => {
    portal.config = { softFrom: '', hardFrom: '', off: '' }
    const wrapper = await mountApp()
    expect(portal.asked).toBeGreaterThan(0)
    expect(wrapper.attributes('data-stage')).toBe('none')
  })
})

describe('область действия и обход из адреса', () => {
  /**
   * ⛔ Установщик не блокируется, и сервер о нём даже не спрашивается: через `/install` портал
   * ПЕРЕставляет приложение — заблокируй его, и чинить на портале клиента станет нечем, в том
   * числе снимать саму блокировку.
   */
  it('на установщике настроек не спрашивают вовсе', async () => {
    portal.pathname = '/install'
    portal.config = { softFrom: PAST, hardFrom: PAST, off: '' }
    const wrapper = await mountApp()
    expect(portal.asked).toBe(0)
    expect(wrapper.attributes('data-blocking')).toBe('false')
  })

  /**
   * Ради этого обход и заведён: посмотреть экран до наступления даты.
   *
   * ⚠ Заодно проверяется, что срок НЕ ВЫДУМЫВАЕТСЯ. Обход поднимает стадию, но даты на сервере
   * нет — значит экран обязан промолчать про срок, а не подставить что-нибудь правдоподобное.
   */
  it('?lock=hard показывает экран при пустом расписании и не выдумывает срок', async () => {
    portal.lockParam = 'hard'
    portal.config = { softFrom: '', hardFrom: '', off: '' }
    const wrapper = await mountApp()
    expect(wrapper.attributes('data-stage')).toBe('hard')
    expect(wrapper.get('[data-testid="hard-from"]').text()).toBe('')
  })

  /**
   * ⛔ И то, ради чего обход умеет только ПОВЫШАТЬ: `?lock=soft` в день жёсткой блокировки не
   * понижает её до отсчёта. Иначе ссылка из адресной строки стала бы ключом от блокировки.
   */
  it('?lock=soft не понижает жёсткую блокировку', async () => {
    portal.lockParam = 'soft'
    portal.config = { softFrom: PAST, hardFrom: PAST, off: '' }
    expect((await mountApp()).attributes('data-stage')).toBe('hard')
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
    expect(wrapper.text()).toContain('Доступ к отчётам приостановлен')
  })

  /**
   * ⛔ Формулировки НЕЙТРАЛЬНЫЕ — решение владельца 2026-09-16, и сторожить его надо тестом, а не
   * комментарием.
   *
   * Экран видит ЛЮБОЙ сотрудник клиента, открывший отчёт: рядовой менеджер, а не тот, кто ведёт
   * расчёты. Слово про деньги или долг выставило бы его работодателя должником перед собственным
   * коллективом — приложение не имеет права вмешиваться в отношения внутри компании клиента. Слово
   * «акт» убрано отдельно: это документ, которого у сотрудника перед глазами нет, и упоминание
   * привязывает формальность к конкретной бумаге.
   */
  it.each([
    ['soft' as const, 20],
    ['hard' as const, 20]
  ])('на экране (%s) нет ни денег, ни долга, ни актов', async (stage, remaining) => {
    const wrapper = await mountSuspended(PaymentLockScreen, { props: { stage, remaining, hardFrom: '2026-09-21' } })
    const text = wrapper.text().toLowerCase()
    for (const forbidden of ['оплат', 'оплач', 'деньг', 'долг', 'задолж', 'счёт', 'акт', 'не заплат']) {
      expect(text).not.toContain(forbidden)
    }
    // ⚠ И проверка «текст вообще есть»: пустой экран прошёл бы запрет на слова, ничего не сказав.
    expect(text).toContain('приём')
  })
})
