// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { BATCH_LIMIT, useB24Batch } from '~/composables/useB24Batch'
import type { BatchCommand } from '~/utils/b24Query'

/**
 * Пакетные запросы — общая механика обоих отчётов.
 *
 * ⚠ Главное здесь — нарезка по 50. На боевом портале отчёт по менеджерам задаёт 143 вопроса
 * одним заходом, то есть режется на три пакета ВСЕГДА, а в тестах отчётов наборы маленькие и эта
 * ветка не срабатывает ни разу. Сломанный срез или потерянный кусок ответа при этом выглядел бы
 * как «часть менеджеров исчезла из таблицы» — молча.
 */
const portal = vi.hoisted(() => ({
  /** Сколько раз позвали `batch.make` и с какими наборами команд. */
  calls: [] as Array<string[]>,
  fail: false,
  /** Команда, ответ которой приходит «сломанным»: портал ответил ошибкой на неё одну. */
  broken: undefined as string | undefined
}))

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => true,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  openPath: async () => true,
  getOrThrow: () => ({
    actions: {
      v2: {
        batch: {
          make: async ({ calls }: { calls: Record<string, BatchCommand> }) => {
            const keys = Object.keys(calls)
            portal.calls.push(keys)
            if (portal.fail) return { isSuccess: false, getData: () => undefined, getErrorMessages: () => ['портал недоступен'] }
            const data: Record<string, unknown> = {}
            for (const key of keys) {
              data[key] = key === portal.broken
                ? {}
                : { getTotal: () => Number(key.slice(1)), getData: () => ({ result: [{ ID: key }] }) }
            }
            return { isSuccess: true, getData: () => data, getErrorMessages: () => [] }
          }
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.calls = []
  portal.fail = false
  portal.broken = undefined
})

function commands(count: number): Record<string, BatchCommand> {
  const out: Record<string, BatchCommand> = {}
  for (let i = 0; i < count; i++) out[`n${i}`] = { method: 'crm.deal.list', params: { select: ['ID'], filter: {}, start: 0 } }
  return out
}

describe('useB24Batch', () => {
  it('набор до предела уходит одним пакетом', async () => {
    await useB24Batch().batchTotals(commands(BATCH_LIMIT))
    expect(portal.calls).toHaveLength(1)
    expect(portal.calls[0]).toHaveLength(BATCH_LIMIT)
  })

  // 143 счётчика боевого прогона — это три пакета; ответы всех трёх обязаны попасть в один набор.
  it('набор больше предела режется по 50, и ответы всех кусков складываются вместе', async () => {
    const totals = await useB24Batch().batchTotals(commands(143))
    expect(portal.calls.map(keys => keys.length)).toEqual([50, 50, 43])
    expect(Object.keys(totals)).toHaveLength(143)
    expect(totals.n0).toBe(0)
    expect(totals.n142).toBe(142)
  })

  it('строки читаются по тем же ключам', async () => {
    const rows = await useB24Batch().batchRows<{ ID: string }>(commands(51))
    expect(rows.n50).toEqual([{ ID: 'n50' }])
  })

  // Пакет целиком не прошёл — это ошибка отчёта, а не «данных нет»: молча вернуть пустой набор
  // значило бы показать нули как факт о работе.
  it('неудачный пакет бросает ошибку с сообщением портала', async () => {
    portal.fail = true
    await expect(useB24Batch().batchTotals(commands(3))).rejects.toThrow('портал недоступен')
  })

  // Одна команда пакета ответила ошибкой (пакет идёт с `isHaltOnError: false`): её счётчик — ноль,
  // остальные команды при этом не должны пострадать.
  it('сломанный ответ одной команды не роняет весь пакет', async () => {
    portal.broken = 'n1'
    const results = await useB24Batch().batchResults(commands(3))
    expect(results.n1).toEqual({ data: undefined, total: 0 })
    expect(results.n2!.total).toBe(2)
  })
})
