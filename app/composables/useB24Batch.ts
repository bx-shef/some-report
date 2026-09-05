import type { BatchCommand } from '~/utils/b24Query'

/** Предел портала: команд в одном пакете. Больше — портал молча выполнит первые 50. */
export const BATCH_LIMIT = 50

/**
 * Пакетные запросы к порталу — общая механика обоих отчётов.
 *
 * Оба отчёта задают порталу СОТНИ вопросов «сколько» и десяток справочников, и оба делают это
 * одинаково: команды режутся по 50, ответы разбираются по именам команд. Держать эту механику в
 * одном месте важнее, чем сэкономить импорт: разъехавшись, две копии дали бы отчёты, которые
 * по-разному читают один и тот же ответ портала.
 *
 * ⚠ Именованные команды SDK умеет только в `batch`, не в `batchByChunk` — поэтому режем сами.
 * ⚠ Пакеты идут ПО ОЧЕРЕДИ, а не параллельно: у портала есть предел интенсивности запросов, и
 * пять пакетов разом стоят отчёту не времени, а ответа «слишком часто» посреди выборки.
 */
export function useB24Batch() {
  const b24 = useB24()

  /** Пакет команд → результат каждой по её ключу: строки и `total`. */
  async function batchResults<T>(commands: Record<string, BatchCommand>): Promise<Record<string, { data: T | undefined, total: number }>> {
    const entries = Object.entries(commands)
    const out: Record<string, { data: T | undefined, total: number }> = {}
    for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
      const chunk = Object.fromEntries(entries.slice(i, i + BATCH_LIMIT))
      const result = await b24.getOrThrow().actions.v2.batch.make<T>({
        calls: chunk,
        options: { isHaltOnError: false, returnAjaxResult: true }
      })
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      const data = result.getData()
      if (typeof data !== 'object' || data === null) continue
      for (const [key, ajax] of Object.entries(data as Record<string, { getData?: () => { result?: T } | undefined, getTotal?: () => number }>)) {
        out[key] = { data: ajax.getData?.()?.result, total: ajax.getTotal?.() ?? 0 }
      }
    }
    return out
  }

  /** Только `total` каждой команды — для счётчиков. */
  async function batchTotals(commands: Record<string, BatchCommand>): Promise<Record<string, number>> {
    const results = await batchResults<unknown>(commands)
    return Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.total]))
  }

  /** Только строки каждой команды — для справочников и цепочек перечисления. */
  async function batchRows<T>(commands: Record<string, BatchCommand>): Promise<Record<string, T[]>> {
    const results = await batchResults<T[]>(commands)
    return Object.fromEntries(Object.entries(results).map(([key, value]) => [key, Array.isArray(value.data) ? value.data : []]))
  }

  return { batchResults, batchTotals, batchRows }
}
