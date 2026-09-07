// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { effectScope } from 'vue'
import { BATCH_LIMIT, RATE_LIMIT_JITTER, RATE_LIMIT_RETRY_DELAYS_MS, useB24Batch } from '~/composables/useB24Batch'
import type { BatchCommand } from '~/utils/b24Query'

/**
 * Пакетные запросы — общая механика всех отчётов.
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
  broken: undefined as string | undefined,
  /**
   * Сколько первых вызовов портал отвергнет по лимиту интенсивности.
   *
   * ⚠ Как настоящий SDK: отказ КОМАНДЫ делает неуспешным ВЕСЬ пакет, а сам код лежит в ошибке
   * по ключу команды (`getErrorsByKey`), не в тексте сообщения.
   */
  rateLimited: 0,
  /** Отвергать не по лимиту, а по другой причине — такое повторять бессмысленно. */
  refuseWith: undefined as string | undefined,
  /** Сколько первых вызовов БРОСЯТ ошибку лимита — так ведёт себя SDK при HTTP 503. */
  throwRateLimit: 0,
  /** Отвергать ПЕРВУЮ попытку каждого пакета: так выглядит устойчиво загруженный портал. */
  rateLimitFirstOfEach: false,
  /** Пакеты, по которым первая попытка уже была отвергнута. */
  seenChunks: new Set<string>()
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
            if (portal.rateLimitFirstOfEach && !portal.seenChunks.has(keys[0] as string)) {
              portal.seenChunks.add(keys[0] as string)
              return {
                isSuccess: false,
                getData: () => undefined,
                getErrorsByKey: () => ({ [keys[0] as string]: { code: 'QUERY_LIMIT_EXCEEDED', message: 'Превышена интенсивность' } }),
                getErrorMessages: () => ['Превышена интенсивность']
              }
            }
            if (portal.rateLimited > 0) {
              portal.rateLimited -= 1
              return {
                isSuccess: false,
                getData: () => undefined,
                getErrorsByKey: () => ({ [keys[0] as string]: { code: 'QUERY_LIMIT_EXCEEDED', message: 'Превышена интенсивность' } }),
                getErrorMessages: () => ['Превышена интенсивность']
              }
            }
            if (portal.throwRateLimit > 0) {
              portal.throwRateLimit -= 1
              // ⚠ Как настоящий SDK при HTTP 503: он БРОСАЕТ `AjaxError` с кодом, а не возвращает
              // неуспешный результат. Своя ветка в `runChunk` есть, и до этого теста её не
              // проверял никто.
              throw Object.assign(new Error('Превышена интенсивность'), { code: 'QUERY_LIMIT_EXCEEDED', status: 503 })
            }
            if (portal.refuseWith) {
              return {
                isSuccess: false,
                getData: () => undefined,
                getErrorsByKey: () => ({ [keys[0] as string]: { code: portal.refuseWith, message: 'отказ' } }),
                getErrorMessages: () => ['отказ']
              }
            }
            if (portal.fail) return { isSuccess: false, getData: () => undefined, getErrorsByKey: () => ({}), getErrorMessages: () => ['портал недоступен'] }
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
  portal.rateLimited = 0
  portal.refuseWith = undefined
  portal.throwRateLimit = 0
  portal.rateLimitFirstOfEach = false
  portal.seenChunks = new Set<string>()
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

  /**
   * Одна команда пакета ответила ошибкой (пакет идёт с `isHaltOnError: false`) — остальные
   * команды при этом не должны пострадать.
   *
   * ⚠ У такой команды ответа НЕТ ВОВСЕ, и это не то же самое, что «ответ с нулём». Счётчику
   * разницы нет (`collectTotals` пропускает отсутствующий ключ, клетка остаётся нулём), а вот
   * цепочке перечисления — есть: для неё пустой ответ означает «значения кончились», и молчаливый
   * ноль обрывал бы список менеджеров на полуслове (см. `batchRowsChecked`).
   */
  it('сломанный ответ одной команды не роняет весь пакет', async () => {
    portal.broken = 'n1'
    const results = await useB24Batch().batchResults(commands(3))
    expect(results.n1).toBeUndefined()
    expect(results.n2!.total).toBe(2)
  })

  it('счётчики сломанной команды просто нет — соседние на месте', async () => {
    portal.broken = 'n1'
    const totals = await useB24Batch().batchTotals(commands(3))
    expect(totals).not.toHaveProperty('n1')
    expect(totals.n2).toBe(2)
  })

  // ⚠ Ради этого флага метод и заведён: цепочка перечисления обязана отличить «значения
  // кончились» от «одна команда не ответила», иначе отчёт молча теряет половину менеджеров.
  it('batchRowsChecked говорит, что ответили не все', async () => {
    portal.broken = 'n1'
    const partial = await useB24Batch().batchRowsChecked<{ ID: string }>(commands(3))
    expect(partial.complete).toBe(false)
    expect(partial.rows.n2).toEqual([{ ID: 'n2' }])

    portal.broken = undefined
    const full = await useB24Batch().batchRowsChecked<{ ID: string }>(commands(3))
    expect(full.complete).toBe(true)
  })
})

describe('лимит интенсивности запросов портала', () => {
  /**
   * ⛔ Отказ ОДНОЙ команды делает неуспешным ВЕСЬ пакет: из-за неё терялись ответы остальных
   * сорока девяти, а человек читал «не удалось прочитать данные портала» — без причины и без
   * единой попытки повторить. Платформа при этом сама советует повторять с растущей паузой.
   */
  it('пакет, упёршийся в лимит, повторяется и доходит', async () => {
    vi.useFakeTimers()
    try {
      portal.rateLimited = 1
      const { batchTotals } = useB24Batch()
      const pending = batchTotals({ p1: { method: 'crm.deal.list', params: {} } })
      // ⚠ Двигаем время по КОНСТАНТЕ и с запасом на разброс: хардкод «1000» при правке паузы не
      // краснел бы, а ВИС бы до тайм-аута — диагностика хуже, чем у любого падения.
      await vi.advanceTimersByTimeAsync(Math.ceil(RATE_LIMIT_RETRY_DELAYS_MS[0]! * (1 + RATE_LIMIT_JITTER)) + 1)
      await expect(pending).resolves.toEqual({ p1: 1 })
      // Именно ПОВТОР, а не одна попытка: портал спрошен дважды тем же набором команд.
      expect(portal.calls).toHaveLength(2)
      expect(portal.calls[0]).toEqual(portal.calls[1])
    } finally {
      vi.useRealTimers()
    }
  })

  // ⚠ Попытки не бесконечны: отчёт открыт перед человеком, и минута молчаливого ожидания хуже
  // честного «портал просит реже».
  it('когда повторы не помогли — говорит про частоту запросов, а не «не удалось»', async () => {
    vi.useFakeTimers()
    try {
      portal.rateLimited = 99
      const { batchTotals } = useB24Batch()
      const pending = batchTotals({ p1: { method: 'crm.deal.list', params: {} } })
      const caught = expect(pending).rejects.toThrow(/частоту запросов/)
      await vi.advanceTimersByTimeAsync(10_000)
      await caught
      // Три попытки: первая и две с растущими паузами.
      expect(portal.calls).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * ⚠ Повторяем ТОЛЬКО лимит. «Нет права» повтором не лечится: вторая попытка добавит ожидания
   * и вернёт ту же ошибку, а человек всё это время смотрит на крутилку.
   */
  it('чужой отказ не повторяется', async () => {
    portal.refuseWith = 'INSUFFICIENT_SCOPE'
    const { batchTotals } = useB24Batch()
    await expect(batchTotals({ p1: { method: 'crm.deal.list', params: {} } })).rejects.toThrow(/отказ/)
    expect(portal.calls).toHaveLength(1)
  })
})

describe('лимит на уровне запроса, а не команды', () => {
  /**
   * ⚠ У SDK есть СВОЙ повтор — но он на уровне HTTP-запроса (`maxRetries`, экспоненциальная
   * пауза для 503 и `QUERY_LIMIT_EXCEEDED`). Пакет с отказавшей КОМАНДОЙ приходит со статусом
   * 200, ошибка лежит внутри — встроенный повтор её не видит. Эта ветка — про другой случай:
   * когда портал отверг сам запрос, и SDK уже исчерпал свои попытки.
   */
  it('брошенная ошибка лимита тоже повторяется', async () => {
    vi.useFakeTimers()
    try {
      portal.throwRateLimit = 1
      const { batchTotals } = useB24Batch()
      const pending = batchTotals({ p1: { method: 'crm.deal.list', params: {} } })
      await vi.advanceTimersByTimeAsync(Math.ceil(RATE_LIMIT_RETRY_DELAYS_MS[0]! * (1 + RATE_LIMIT_JITTER)) + 1)
      await expect(pending).resolves.toEqual({ p1: 1 })
      expect(portal.calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // ⚠ Исходную ошибку кладём в `cause`: человеку нужен понятный текст, а тому, кто разбирает
  // «у меня не работает» на боевом портале, — код и детали ответа портала.
  it('исходная ошибка портала сохраняется в cause', async () => {
    vi.useFakeTimers()
    try {
      portal.throwRateLimit = 99
      const { batchTotals } = useB24Batch()
      const pending = batchTotals({ p1: { method: 'crm.deal.list', params: {} } }).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(30_000)
      const error = await pending as Error
      expect(error.message).toMatch(/частоту запросов/)
      expect((error.cause as { code?: string })?.code).toBe('QUERY_LIMIT_EXCEEDED')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('отмена во время паузы повтора', () => {
  /**
   * ⛔ Ровно тот момент, ради которого отмена и заводилась: портал УЖЕ попросил подождать, а
   * человек уже ушёл со страницы. Повторять здесь значит отнимать и без того исчерпанный лимит
   * у той страницы, что открыта сейчас.
   *
   * ⚠ Проверки поколения в самих отчётах этого не ловят: они стоят МЕЖДУ страницами, а пауза
   * идёт ВНУТРИ одного вызова пакета.
   */
  it('ушли со страницы во время паузы — второй попытки не будет', async () => {
    vi.useFakeTimers()
    try {
      portal.rateLimited = 99
      const scope = effectScope()
      let batchTotals!: ReturnType<typeof useB24Batch>['batchTotals']
      scope.run(() => {
        batchTotals = useB24Batch().batchTotals
      })

      const pending = batchTotals({ p1: { method: 'crm.deal.list', params: {} } }).catch(() => 'остановлено')
      // Первая попытка ушла и упёрлась в лимит — дальше идёт пауза.
      await vi.advanceTimersByTimeAsync(0)
      expect(portal.calls).toHaveLength(1)

      scope.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      await pending

      // Ни одной новой попытки: пауза кончилась уже после ухода со страницы.
      expect(portal.calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('общий бюджет ожидания', () => {
  /**
   * ⛔ Повтор живёт ВНУТРИ пакета, а пакетов в выборке бывает полтора десятка. При устойчивом
   * отказе портала ожидание складывалось бы по каждому и дало бы минуту молчания вместо честной
   * ошибки — человек всё это время смотрит на крутилку и не знает, ждать ему или перезагружать.
   *
   * Здесь портал отвергает ПЕРВУЮ попытку каждого пакета: бюджета хватает не на все.
   */
  it('при устойчивом отказе повторяются не все пакеты подряд', async () => {
    vi.useFakeTimers()
    try {
      portal.rateLimitFirstOfEach = true
      const chunks = 15
      const commands = Object.fromEntries(
        Array.from({ length: chunks * BATCH_LIMIT }, (_, index) => [`p${index}`, { method: 'crm.deal.list', params: {} }])
      )
      const { batchTotals } = useB24Batch()
      const pending = batchTotals(commands).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(120_000)
      const outcome = await pending as Error

      /**
       * ⚠ Исчерпав бюджет, выборка ПАДАЕТ, а не отдаёт то, что успела. Вернуть часть пакетов
       * значило бы показать неполные числа как полные — ровно тот дефект, ради которого в
       * `fetchAllPaged` заведена проверка полноты.
       */
      expect(outcome.message).toMatch(/частоту запросов/)
      // И ждала она не бесконечно: повторён НЕ каждый пакет из пятнадцати.
      expect(portal.calls.length).toBeLessThan(chunks * 2)
    } finally {
      vi.useRealTimers()
    }
  })
})
