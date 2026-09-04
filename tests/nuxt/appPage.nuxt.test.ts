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
  pending: {} as Record<string, (rows: unknown[]) => void>
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
        batch: { make: async ({ calls }: { calls: Record<string, unknown> }) => batchAnswer(calls) },
        call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { categories: [] } }) }) },
        callList: {
          make: ({ params }: { params: { filter: Record<string, string> } }) => new Promise((resolve) => {
            portal.pending[params.filter['>=DATE_CREATE'] ?? '?'] = rows => resolve({ isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
          })
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.initialized = true
  portal.pending = {}
})

describe('страница отчёта в портале', () => {
  it('до ответа портала — только «Загрузка», после — отчёт', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(Object.keys(portal.pending)).toHaveLength(1))

    const before = wrapper.text()
    expect(before).toContain('Загрузка')
    expect(before).not.toContain('Сводка')
    expect(before).not.toContain('Демо-данные')
    expect(before).not.toContain('Это НЕ данные вашего портала')
    // Период демо-набора (август) на панели не показывается — только выбранный.
    expect(before).not.toContain('01.08.2026')

    Object.values(portal.pending)[0]!([])
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('Загрузка…'))
    const after = wrapper.text()
    expect(after).toContain('1. Сводка')
    expect(after).not.toContain('Демо-данные')
  })

  it('вне портала «Загрузка» сменяется демо-набором с предупреждением', async () => {
    portal.initialized = false
    const wrapper = await mountSuspended(AppPage, { route: '/app?preview=1' })
    await vi.waitFor(() => expect(wrapper.text()).toContain('Это НЕ данные вашего портала'))
    expect(wrapper.text()).toContain('Демо-данные')
    expect(wrapper.text()).not.toContain('Загрузка…')
  })
})
