// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useUserOptions } from '~/composables/useUserOptions'

/**
 * Настройки отчёта, запомненные порталом за человеком.
 *
 * ⚠ Проверяем не «сохранилось ли», а то, что ломается молча: сколько РАЗ мы ходим в портал (одно
 * чтение на страницу, никаких повторов той же записи) и что любой отказ портала не мешает отчёту
 * открыться. Первое дорого: настройки читаются перед первой выборкой, и лишний круг по сети
 * человек видит как задержку отчёта.
 */
const portal = vi.hoisted(() => ({
  initialized: true,
  /** Что «помнит» портал. */
  options: {} as Record<string, unknown>,
  /** Каждая команда, ушедшая в портал: метод и параметры. */
  calls: [] as Array<{ method: string, params: Record<string, unknown> }>,
  /** Портал отвечает отказом. */
  fails: false,
  /** Портал бросает исключение (лимит запросов, сеть). */
  throws: false
}))

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => portal.initialized,
  getOrThrow: () => ({
    actions: {
      v2: {
        call: {
          make: async ({ method, params }: { method: string, params: Record<string, unknown> }) => {
            portal.calls.push({ method, params })
            if (portal.throws) throw new Error('слишком часто')
            if (portal.fails) return { isSuccess: false, getData: () => undefined, getErrorMessages: () => ['отказ'] }
            if (method === 'user.option.get') {
              return { isSuccess: true, getData: () => ({ result: portal.options }), getErrorMessages: () => [] }
            }
            return { isSuccess: true, getData: () => ({ result: true }), getErrorMessages: () => [] }
          }
        }
      }
    }
  })
}))

/** Записи идут «в фон» без ожидания — даём очереди микрозадач провернуться. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  portal.initialized = true
  portal.options = {}
  portal.calls = []
  portal.fails = false
  portal.throws = false
})

const reads = () => portal.calls.filter(call => call.method === 'user.option.get')
const writes = () => portal.calls.filter(call => call.method === 'user.option.set')

describe('useUserOptions: чтение', () => {
  it('отдаёт сохранённое значение по ключу', async () => {
    portal.options['report.leads.v1'] = '{"period":{"from":"2026-09-01","to":"2026-09-30"}}'
    const options = useUserOptions()
    expect(await options.read('report.leads.v1')).toBe(portal.options['report.leads.v1'])
  })

  // ⚠ Один запрос на страницу: оба отчёта спрашивают свои ключи, а портал отвечает разом.
  it('спрашивает портал один раз, дальше берёт из памяти', async () => {
    const options = useUserOptions()
    await options.read('report.leads.v1')
    await options.read('report.managers.v1')
    expect(reads()).toHaveLength(1)
  })

  it('ключа нет — undefined, а не ошибка', async () => {
    expect(await useUserOptions().read('report.leads.v1')).toBeUndefined()
  })

  it.each([
    ['портал отказал', () => { portal.fails = true }],
    ['портал бросил исключение', () => { portal.throws = true }]
  ])('%s — отчёт открывается с умолчанием', async (_name, breakIt) => {
    breakIt()
    expect(await useUserOptions().read('report.leads.v1')).toBeUndefined()
  })

  // Вне портала SDK нет вовсе: предпросмотр не должен ходить в сеть и не должен падать.
  it('вне портала не спрашивает ничего', async () => {
    portal.initialized = false
    expect(await useUserOptions().read('report.leads.v1')).toBeUndefined()
    expect(portal.calls).toEqual([])
  })
})

describe('useUserOptions: запись', () => {
  it('кладёт значение под своим ключом', async () => {
    useUserOptions().write('report.managers.v1', '{"categoryId":1}')
    await settle()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.params).toEqual({ options: { 'report.managers.v1': '{"categoryId":1}' } })
  })

  /**
   * ⚠ Повтор того же значения в портал не уходит. Отбор присваивается целым объектом, и наблюдатель
   * страницы срабатывает и тогда, когда человек выбрал ТО ЖЕ САМОЕ, — без этой проверки каждая
   * такая мелочь стоила бы лишнего запроса посреди выборки отчёта.
   */
  it('то же значение второй раз не пишет, изменившееся — пишет', async () => {
    const options = useUserOptions()
    options.write('report.leads.v1', 'первое')
    options.write('report.leads.v1', 'первое')
    await settle()
    expect(writes()).toHaveLength(1)

    options.write('report.leads.v1', 'второе')
    await settle()
    expect(writes()).toHaveLength(2)
  })

  // Не записалось — отбор просто не запомнится; повторить его должна следующая смена отбора, а не
  // очередь повторов на фоне отчёта.
  it('после отказа портала то же значение можно записать снова', async () => {
    portal.throws = true
    const options = useUserOptions()
    options.write('report.leads.v1', 'значение')
    await settle()
    expect(writes()).toHaveLength(1)

    portal.throws = false
    options.write('report.leads.v1', 'значение')
    await settle()
    expect(writes()).toHaveLength(2)
  })

  it('вне портала не пишет ничего', async () => {
    portal.initialized = false
    useUserOptions().write('report.leads.v1', 'значение')
    await settle()
    expect(portal.calls).toEqual([])
  })
})
