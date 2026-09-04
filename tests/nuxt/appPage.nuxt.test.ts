// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import AppPage from '~/pages/app.vue'

/**
 * Экран отчёта до и после первой выборки.
 *
 * ⚠ Решение владельца от 2026-09-04: пока портал не ответил, на экране только «Загрузка» — ни
 * демо-чисел, ни значка «Демо-данные», ни периода демо-набора. Руководитель читает числа раньше
 * плашек, и «1 250 лидов», которых у него нет, однажды уже приняли за свои. Состояние живёт в
 * самой странице, поэтому проверяется монтированием страницы, а не композабла.
 */
const portal = vi.hoisted(() => ({
  initialized: true,
  /** Отложенный ответ построчной выборки: тест сам решает, когда портал «ответил». */
  pending: {} as Record<string, (rows: unknown[]) => void>,
  /** Портал отвечает ошибкой на первый же пакет. */
  batchThrows: false,
  batchCalls: 0
}))

function batchAnswer(commands: Record<string, unknown>) {
  const data: Record<string, { getTotal: () => number, getData: () => { result: unknown[] } }> = {}
  for (const key of Object.keys(commands)) {
    data[key] = { getTotal: () => (key === 'total' ? 7 : 0), getData: () => ({ result: [] }) }
  }
  return { isSuccess: true, getData: () => data, getErrorMessages: () => [] }
}

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => portal.initialized,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  getOrThrow: () => ({
    actions: {
      v2: {
        batch: {
          make: async ({ calls }: { calls: Record<string, unknown> }) => {
            portal.batchCalls++
            if (portal.batchThrows) throw new Error('портал недоступен')
            return batchAnswer(calls)
          }
        },
        call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { categories: [] } }) }) },
        callList: {
          make: ({ params }: { params: { filter: Record<string, string> } }) => new Promise((resolve) => {
            // Сделки из лидов — по дате создания; справка без лида (фоном) — по дате закрытия.
            const key = params.filter['>=DATE_CREATE'] ?? `closed:${params.filter['>=CLOSEDATE'] ?? '?'}`
            portal.pending[key] = rows => resolve({ isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
          })
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.initialized = true
  portal.pending = {}
  portal.batchThrows = false
  portal.batchCalls = 0
})

describe('страница отчёта в портале', () => {
  /** Ключи ОСНОВНЫХ выборок (сделки из лидов), без фоновой справки блока 7. */
  const mainKeys = () => Object.keys(portal.pending).filter(key => !key.startsWith('closed:'))

  it('до ответа портала — только «Загрузка», после — отчёт', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))

    const before = wrapper.text()
    expect(before).toContain('Загрузка')
    expect(before).not.toContain('Сводка')
    expect(before).not.toContain('Демо-данные')
    expect(before).not.toContain('Это НЕ данные вашего портала')
    // Период демо-набора (август) на панели не показывается — только выбранный.
    expect(before).not.toContain('01.08.2026')

    portal.pending[mainKeys()[0]!]!([])
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('Загрузка…'))
    const after = wrapper.text()
    expect(after).toContain('1. Сводка')
    expect(after).not.toContain('Демо-данные')
    // Справка блока 7 ещё считается — и говорит об этом сама, не задерживая отчёт.
    expect(after).toContain('Считаем успешные сделки без лида')
  })

  // ⚠ Кнопки периода живые и во время первой выборки, а наблюдатель периода в это время молчит.
  // Без досылки выборки после загрузки подсветка показывала бы «Прошлый месяц» над числами
  // текущего, и второй клик по той же кнопке ничего не менял бы.
  it('период, выбранный во время первой выборки, дозапрашивается после неё', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
    const firstFrom = mainKeys()[0]!

    const prevMonth = wrapper.findAll('button').find((b: { text: () => string }) => b.text() === 'Прошлый месяц')!
    await prevMonth.trigger('click')
    // Пока первая выборка идёт, второй запрос не уходит.
    expect(mainKeys()).toHaveLength(1)

    portal.pending[firstFrom]!([])
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(2))
    const secondFrom = mainKeys().find(key => key !== firstFrom)!
    expect(secondFrom < firstFrom).toBe(true)

    portal.pending[secondFrom]!([])
    // Подпись периода на панели — по загруженным данным, то есть по прошлому месяцу.
    await vi.waitFor(() => expect(wrapper.text()).toContain(`${secondFrom.slice(8, 10)}.${secondFrom.slice(5, 7)}.${secondFrom.slice(0, 4)}`))
    expect(wrapper.text()).not.toContain('Загрузка…')
  })

  // ⚠ При ошибке набор остаётся демонстрационным со своим периодом. Сравнение «выбранный период
  // против периода набора» слало бы второй запрос в упавший портал — без единого клика.
  it('ошибка портала — один запрос, плашка об ошибке и демо-набор, а не повтор', async () => {
    portal.batchThrows = true
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(wrapper.text()).toContain('Не удалось прочитать данные портала'))
    expect(portal.batchCalls).toBe(1)
    expect(wrapper.text()).toContain('Показан демонстрационный набор')
    expect(wrapper.text()).toContain('Это НЕ данные вашего портала')
  })

  it('вне портала «Загрузка» сменяется демо-набором с предупреждением', async () => {
    portal.initialized = false
    const wrapper = await mountSuspended(AppPage, { route: '/app?preview=1' })
    await vi.waitFor(() => expect(wrapper.text()).toContain('Это НЕ данные вашего портала'))
    expect(wrapper.text()).toContain('Демо-данные')
    expect(wrapper.text()).not.toContain('Загрузка…')
  })
})
