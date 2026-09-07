import { getCurrentScope, onScopeDispose } from 'vue'
import type { BatchCommand } from '~/utils/b24Query'
import { hasRateLimit, isRateLimit, RATE_LIMIT_MESSAGE, retryDelayMs } from '~/utils/b24Errors'

/** Предел портала: команд в одном пакете. Больше — портал молча выполнит первые 50. */
export const BATCH_LIMIT = 50

/**
 * Паузы перед повторами пакета, упёршегося в лимит интенсивности.
 *
 * ⚠ Растущие — так советует сама платформа: она считает запросы «дырявым ведром», и ведро
 * освобождается со временем. Две попытки, а не пять: отчёт открыт перед человеком, и минута
 * молчаливого ожидания хуже честного «портал просит реже».
 *
 * ⚠ Секунда — не догадка: на обычных тарифах ведро течёт со скоростью 2 запроса в секунду, то
 * есть за первую паузу освобождается пара мест, за вторую — ещё шесть.
 */
export const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 3000] as const

/**
 * Разброс паузы — доля от неё самой.
 *
 * ⛔ Без него все, кто упёрся в лимит одновременно, повторят ровно через секунду и ровно через
 * три — то есть постучатся в портал в один и тот же момент. Отчёт общий: его открывают несколько
 * руководителей, да и один отчёт пускает несколько фоновых проходов сразу. Документация портала
 * прямо просит «не пускать параллельные серии с одного адреса» — фиксированная пауза делает
 * ровно это, только хором.
 */
export const RATE_LIMIT_JITTER = 0.3

/**
 * Сколько всего можно прождать на повторах в ОДНОЙ выборке.
 *
 * ⚠ Повтор живёт внутри пакета, а пакетов в выборке до полутора десятков: при устойчивом отказе
 * ожидание складывалось бы по каждому и дало бы минуту молчания вместо честной ошибки. Бюджет
 * общий на всю выборку — исчерпав его, отчёт перестаёт ждать и говорит правду.
 */
export const RATE_LIMIT_TOTAL_BUDGET_MS = 12_000

/**
 * Пакетные запросы к порталу — общая механика всех отчётов.
 *
 * Отчёты задают порталу СОТНИ вопросов «сколько» и десяток справочников, и оба делают это
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

  /**
   * Страница закрыта — повторять уже некому.
   *
   * ⚠ Флаг живёт ЗДЕСЬ, а не приезжает параметром: `useB24Batch()` зовут внутри той же области,
   * что и сам отчёт, и умирают они вместе. Протаскивать «поколение» отчёта в пакетную механику
   * значило бы учить её различать `seq` и `periodSeq` — знание, которое ей не нужно.
   */
  let disposed = false
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
    })
  }

  /** Пауза перед повтором — со случайным разбросом, чтобы клиенты не стучались хором. */
  function retryDelay(index: number): number {
    return retryDelayMs(RATE_LIMIT_RETRY_DELAYS_MS[index] ?? 0, RATE_LIMIT_JITTER, Math.random())
  }

  /**
   * Один пакет с повтором при отказе по интенсивности запросов.
   *
   * ⛔ Отказ ОДНОЙ команды делает неуспешным ВЕСЬ пакет: SDK складывает ошибки команд во внешний
   * результат по их ключам, и `isSuccess` становится ложным. Ответы остальных сорока девяти при
   * этом НЕ пропадают — `getData()` базового `Result` отдаёт их независимо от успеха, — но читать
   * их мы не берёмся: неизвестно, каких именно строк не хватает, а неполная страница в выручке
   * хуже честного повтора. Раньше на этом месте выборка просто умирала с плашкой «не удалось
   * прочитать данные портала» — без причины и без единой попытки.
   *
   * ⚠ Повторяем ТОЛЬКО отказ по интенсивности. Остальные (нет права, негодный фильтр, сбой сети)
   * от повтора не исправятся: вторая попытка добавит ожидания и вернёт ту же ошибку.
   *
   * ⚠ И повторяем ПАКЕТ ЦЕЛИКОМ, а не упавшую команду: пакет — это один запрос к порталу, и
   * ведро он занимает целиком. Послать «недостающую» команду отдельно значит послать ещё один
   * запрос в тот момент, когда портал уже просит реже.
   */
  async function runChunk<T>(chunk: Record<string, BatchCommand>, budget: { leftMs: number }, retry: boolean) {
    let lastError: unknown
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const wait = retryDelay(attempt - 1)
        /**
         * ⚠ Бюджет проверяем ДО сна: иначе последний повтор просыпался бы уже за его пределами.
         *
         * ⚠ Исчерпав его, выборка ПАДАЕТ, а не отдаёт то, что успела: часть пакетов — это часть
         * строк, показанная как целое. Молчаливая недостача хуже честного «портал просит реже».
         */
        if (wait > budget.leftMs) break
        budget.leftMs -= wait
        await new Promise(resolve => setTimeout(resolve, wait))
        // ⛔ И отмену — ПОСЛЕ сна: за эти секунды человек мог уйти со страницы, а повторять ради
        // закрытой страницы значит отнимать лимит у той, что открыта сейчас. Ровно в этот момент
        // портал и перегружен — он же попросил подождать.
        if (disposed) break
      }
      try {
        const result = await b24.getOrThrow().actions.v2.batch.make<T>({
          calls: chunk,
          options: { isHaltOnError: false, returnAjaxResult: true }
        })
        if (result.isSuccess) return result
        // ⚠ Ошибки команд достаём ПО КЛЮЧАМ: `getErrorMessages()` отдаёт только текст, а решение
        // «повторять или нет» принимается по коду.
        const errors = result.getErrorsByKey()
        if (!retry || !hasRateLimit(errors)) throw new Error(result.getErrorMessages().join('; '))
        lastError = new Error(result.getErrorMessages().join('; '))
      } catch (error) {
        // Портал может ответить лимитом и на уровне запроса (HTTP 503), а не команды.
        if (!retry || !isRateLimit(error)) throw error
        lastError = error
      }
      if (disposed) break
    }
    // ⚠ Исходную ошибку кладём в `cause`: человеку нужен понятный текст, а тому, кто разбирает
    // «у меня не работает» на боевом портале, — код и детали ответа портала. Без `cause` в
    // трекере оставался бы только наш текст, одинаковый для всех случаев.
    throw new Error(RATE_LIMIT_MESSAGE, { cause: lastError })
  }

  /**
   * Пакет команд → результат каждой по её ключу: строки и `total`.
   *
   * ⚠ `retryOnRateLimit: false` — для НЕОБЯЗАТЕЛЬНЫХ запросов, без которых экран всё равно
   * покажется. Ждать четыре секунды ради подписей, которые в худшем случае заменятся кодами, —
   * это заставить человека смотреть на крутилку ровно за то же самое.
   */
  async function batchResults<T>(
    commands: Record<string, BatchCommand>,
    options: { retryOnRateLimit?: boolean } = {}
  ): Promise<Record<string, { data: T | undefined, total: number }>> {
    const entries = Object.entries(commands)
    const out: Record<string, { data: T | undefined, total: number }> = {}
    // ⚠ Бюджет ОДИН на всю выборку, а не на пакет: пакетов бывает полтора десятка, и повтор в
    // каждом сложился бы в минуту молчания вместо честной ошибки.
    const budget = { leftMs: RATE_LIMIT_TOTAL_BUDGET_MS }
    const retry = options.retryOnRateLimit !== false
    for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
      const chunk = Object.fromEntries(entries.slice(i, i + BATCH_LIMIT))
      const result = await runChunk<T>(chunk, budget, retry)
      const data = result.getData()
      if (typeof data !== 'object' || data === null) continue
      for (const [key, ajax] of Object.entries(data as Record<string, { getData?: () => { result?: T } | undefined, getTotal?: () => number }>)) {
        // ⚠ Форму элемента проверяем в рантайме: это ИНСТАНС SDK с методами, а не JSON, и при
        // смене формата слепое приведение молча вернуло бы `total: 0` по каждой команде — то
        // есть все счётчики отчёта стали бы нулями без единого признака поломки.
        if (typeof ajax?.getTotal !== 'function' && typeof ajax?.getData !== 'function') continue
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
  async function batchRows<T>(
    commands: Record<string, BatchCommand>,
    options: { retryOnRateLimit?: boolean } = {}
  ): Promise<Record<string, T[]>> {
    const results = await batchResults<T[]>(commands, options)
    return Object.fromEntries(Object.entries(results).map(([key, value]) => [key, Array.isArray(value.data) ? value.data : []]))
  }

  /**
   * То же, что `batchRows`, плюс ответ на вопрос «все ли команды пакета ответили».
   *
   * ⚠ Нужен там, где пустой ответ ЗНАЧИМ. Для цепочки перечисления пустой ответ означает
   * «значения кончились» — и отчёт молча терял бы половину менеджеров, считая, что перечислил
   * всех. Флаг позволяет отличить «ответила пустотой» от «не ответила вовсе».
   *
   * ⚠ Речь именно про ПУСТОЙ ответ, а не про отказ: отказ любой команды делает неуспешным весь
   * пакет, и `runChunk` его бросает (повторив, если это лимит интенсивности). Ключ пропадает из
   * ответа только когда портал вернул по команде НИЧЕГО — ни строк, ни ошибки.
   */
  async function batchRowsChecked<T>(commands: Record<string, BatchCommand>): Promise<{ rows: Record<string, T[]>, complete: boolean }> {
    const results = await batchResults<T[]>(commands)
    const rows = Object.fromEntries(Object.entries(results).map(([key, value]) => [key, Array.isArray(value.data) ? value.data : []]))
    return { rows, complete: Object.keys(commands).every(key => key in results) }
  }

  return { batchResults, batchTotals, batchRows, batchRowsChecked }
}
