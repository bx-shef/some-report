// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import InstallPage from '~/pages/install.vue'

/**
 * Страница установки — единственное место проекта, где склеены порядок вызовов REST и решение
 * «что показать человеку». Дважды подряд именно она уехала к заказчику с ложным «Готово»:
 * сначала показывая успех по ответу `placement.bind`, потом — по непроверенному пустому списку
 * точек. Чистые функции в `installDiagnostics.ts` при этом были исправны и покрыты: дефект жил
 * в склейке. Поэтому склейка тоже под тестом.
 */
const portal = vi.hoisted(() => ({
  /** Ответы REST по методам. Тест подменяет нужные, остальные отвечают «всё хорошо». */
  answers: {} as Record<string, unknown>,
  /** Порядок вызовов: по нему проверяем, что снятие идёт ПЕРЕД привязкой. */
  calls: [] as string[],
  initialized: true,
  isAdmin: true,
  installFinishThrows: false
}))

/** Адреса обработчиков, которые построит страница из `siteUrl` (задан в `vitest.config.ts`). */
const LEADS_HANDLER = 'https://report.example.com/app/leads'
const MANAGERS_HANDLER = 'https://report.example.com/app/managers'

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => portal.initialized,
  targetOrigin: () => (portal.initialized ? 'https://example.bitrix24.by' : '?'),
  getRequiredRights: () => ['crm', 'placement', 'user_brief'],
  fitWindow: async () => {},
  getOrThrow: () => ({
    auth: { isAdmin: portal.isAdmin },
    installFinish: async () => {
      if (portal.installFinishThrows) throw new Error('уже завершена')
    },
    callMethod: async (method: string) => {
      portal.calls.push(method)
      const answer = portal.answers[method]
      if (answer instanceof Error) throw answer
      return { getData: () => ({ result: answer }) }
    }
  })
}))

/** Портал, у которого всё в порядке: права выданы, установка завершена, оба пункта на месте. */
function healthyPortal() {
  portal.answers = {
    'placement.bind': true,
    'app.info': { INSTALLED: true },
    'scope': ['crm', 'placement', 'user_brief'],
    'placement.get': [
      { placement: 'CRM_ANALYTICS_MENU', handler: LEADS_HANDLER },
      { placement: 'CRM_ANALYTICS_MENU', handler: MANAGERS_HANDLER }
    ],
    'placement.unbind': { count: 2 }
  }
}

beforeEach(() => {
  portal.calls = []
  portal.initialized = true
  portal.isAdmin = true
  portal.installFinishThrows = false
  healthyPortal()
})

/**
 * Дать странице доработать.
 *
 * ⚠ `mountSuspended` дожидается только `setup`, а вся установка живёт в `onMounted` и состоит
 * из цепочки `await`-ов. Без этой прокрутки тест читал бы экран на строке «Регистрируем
 * отчёт…» и проверял бы промежуточное состояние вместо результата.
 */
async function settle(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
  }
}

async function mountInstall() {
  const wrapper = await mountSuspended(InstallPage)
  await settle(wrapper)
  return wrapper
}

async function click(wrapper: Awaited<ReturnType<typeof mountSuspended>>, label: string) {
  const button = wrapper.findAll('button').find((b: { text: () => string }) => b.text().includes(label))
  if (!button) throw new Error(`нет кнопки «${label}»`)
  await button.trigger('click')
  await settle(wrapper)
}

describe('страница установки', () => {
  it('на исправном портале доводит установку до зелёного вердикта', async () => {
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('Всё зарегистрировано')
    expect(portal.calls).toContain('placement.bind')
    expect(portal.calls).toContain('app.info')
  })

  // ⚠ Тот самый дефект: `placement.get` не ответил — значит мы НЕ ЗНАЕМ, зарегистрирован отчёт
  // или нет. Показать здесь «Готово» — ровно то, из-за чего заказчик искал отчёт в портале.
  it('при сбое placement.get не показывает «всё хорошо»', async () => {
    portal.answers['placement.get'] = new Error('сеть')
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('Не удалось проверить точки встройки')
    expect(wrapper.text()).not.toContain('Всё зарегистрировано')
  })

  it('без права placement называет его поимённо', async () => {
    portal.answers.scope = ['crm', 'user_brief']
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('placement')
    expect(wrapper.text()).toContain('не выдано право')
  })

  it('при незавершённой установке говорит именно об этом', async () => {
    portal.answers['app.info'] = { INSTALLED: false }
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('неустановленным')
  })

  it('вне портала не трогает REST и говорит об этом', async () => {
    portal.initialized = false
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('вне портала')
    expect(portal.calls).toEqual([])
  })

  // Ссылка на раздел строится из origin портала. Она уже один раз молча не отрисовывалась —
  // `computed` над нереактивным синглтоном вычислялся до инициализации SDK и застревал на null.
  it('печатает адрес раздела CRM-аналитики портала', async () => {
    const wrapper = await mountInstall()
    expect(wrapper.html()).toContain('https://example.bitrix24.by/report/analytics/')
  })

  it('«Проверить снова» не переустанавливает, а только спрашивает портал', async () => {
    const wrapper = await mountInstall()
    portal.calls = []
    await click(wrapper, 'Проверить снова')
    expect(portal.calls).not.toContain('placement.bind')
    expect(portal.calls).toContain('placement.get')
  })

  // Перепривязка снимает регистрацию, видную всему порталу, и лежит рядом с безобидной кнопкой.
  it('перепривязка требует подтверждения вторым нажатием', async () => {
    const wrapper = await mountInstall()
    portal.calls = []
    await click(wrapper, 'Перепривязать точки')
    expect(portal.calls).toEqual([])
    expect(wrapper.text()).toContain('Точно перепривязать?')
  })

  // ⚠ Порядок обязателен: привязка ПОВЕРХ старой оставила бы в меню два одинаковых пункта,
  // один из которых открывает прошлый домен.
  it('после подтверждения снимает старые привязки перед новыми', async () => {
    const wrapper = await mountInstall()
    portal.calls = []
    await click(wrapper, 'Перепривязать точки')
    await click(wrapper, 'Точно перепривязать?')
    expect(portal.calls.indexOf('placement.unbind')).toBeLessThan(portal.calls.indexOf('placement.bind'))
  })

  // ⚠ Наследство прошлой версии: пункт на главную приложения и кнопка в шапке аналитики. После
  // обновления они остались бы в меню рядом с двумя новыми — три входа вместо двух.
  it('видит лишние пункты прошлой версии и зовёт перепривязать', async () => {
    portal.answers['placement.get'] = [
      { placement: 'CRM_ANALYTICS_MENU', handler: LEADS_HANDLER },
      { placement: 'CRM_ANALYTICS_MENU', handler: MANAGERS_HANDLER },
      { placement: 'CRM_ANALYTICS_TOOLBAR', handler: 'https://report.example.com/app' }
    ]
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('лишние пункты')
    expect(wrapper.text()).toContain('Перепривязать точки')
  })

  // Половина установки хуже, чем её отсутствие: человек нашёл бы один отчёт и решил, что второго
  // в приложении нет.
  it('привязан один отчёт из двух — это не «всё хорошо»', async () => {
    portal.answers['placement.get'] = [{ placement: 'CRM_ANALYTICS_MENU', handler: LEADS_HANDLER }]
    const wrapper = await mountInstall()
    expect(wrapper.text()).not.toContain('Всё зарегистрировано')
    expect(wrapper.text()).toContain('Сделки по менеджерам')
  })

  it('не администратору перепривязку не предлагает', async () => {
    portal.isAdmin = false
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('только администратору портала')
  })

  // ⚠ Портал и сам ответит `ACCESS_DENIED`, но лезть к нему незачем: `placement.unbind` от
  // не-администратора — это запрос, который может пройти частично. Проверяем на клиенте и сразу
  // переходим к диагностике, она объяснит, что делать и кому.
  it('не администратор ничего не привязывает — только проверка', async () => {
    portal.isAdmin = false
    await mountInstall()
    expect(portal.calls).not.toContain('placement.unbind')
    expect(portal.calls).not.toContain('placement.bind')
    expect(portal.calls).toContain('placement.get')
  })

  // Повторный installFinish на исправной установке ругается ВСЕГДА — красная плашка под зелёным
  // вердиктом сбивала бы с толку каждый раз, когда всё хорошо.
  it('жалобу installFinish при зелёном вердикте не показывает', async () => {
    portal.installFinishThrows = true
    const wrapper = await mountInstall()
    expect(wrapper.text()).toContain('Всё зарегистрировано')
    expect(wrapper.text()).not.toContain('уже завершена')
  })
})
