import { plainParams } from '~/utils/b24Params'
import { dedupeById, LIST_PAGE_SIZE, listPageCommands, listPageOfKey } from '~/utils/b24Query'
// ⚠ Предел пакета берётся ОТТУДА, где пакеты и режутся (`batchResults`), а не дублируется здесь:
// внешний цикл обязан просить ровно столько страниц, сколько влезает в один пакет, иначе
// `batchResults` порежет уже нарезанное ещё раз и модель скорости из замера перестанет держаться.
import { BATCH_LIMIT } from '~/composables/useB24Batch'

/**
 * Постраничное чтение портала — три способа прочитать список целиком и ни одного знания об
 * отчёте. Что именно спрашивать, решает `b24Query.ts`; кому это нужно — `useReportData.ts`.
 *
 * ⚠ Способов три, и выбор между ними — не вкус, а замер (`docs/PORTAL.md`, 2026-09-07):
 * `fetchAll` — курсором силами SDK, `fetchAllUntil` — своим курсором, чтобы бросить на полпути,
 * `fetchAllPaged` — смещением пакетами, вдвое быстрее курсора там, где можно снять `order`.
 *
 * ⚠ Выделено из `useReportData.ts` (2026-09-18) БЕЗ изменения поведения: это механика чтения,
 * общая по смыслу со `useB24Batch` и `useB24Users`, а не источник данных отчёта. Отдельный
 * модуль нужен и затем, чтобы защиты ниже проверялись напрямую: каждое «⛔» здесь — это дефект,
 * который уже случался, а поймать его через полную выборку отчёта стоит целого стенда портала.
 */

/**
 * Предел страниц одной выборки смещением.
 *
 * ⚠ Не для усечения, а против разгона: число страниц берётся из `total`, который отдаёт ПОРТАЛ.
 * Испорченный или неожиданно огромный `total` увёл бы отчёт в тысячи запросов и исчерпал лимит
 * интенсивности портала — для всех, кто в эту минуту работает в CRM. Год сделок заказчика это
 * ≈ 2 300 страниц, так что предел взят с большим запасом.
 *
 * ⚠ Упёршись в него, выборка ПАДАЕТ, а не отдаёт что успела (в отличие от звонков отчёта 3,
 * где предел усекает). Здесь строки идут в ВЫРУЧКУ: молча показанная половина выручки хуже,
 * чем честное «не удалось прочитать».
 */
export const PAGED_MAX_PAGES = 4000

/**
 * Строки одного ответа — с проверкой конверта.
 *
 * ⚠ Списки CRM отдают `result: [...]`, а `crm.stagehistory.list` — `result: { items: [...] }`.
 * Сюда ходят только первые, и «непонятный конверт → пустой массив» означало бы выборку, тихо
 * вернувшую ноль строк при исправном портале. Поэтому непонятное — ошибка.
 */
function expectRows<T>(raw: unknown, method: string): T[] {
  if (Array.isArray(raw)) return raw as T[]
  throw new Error(`Ответ ${method} пришёл не списком строк`)
}

export function useB24Paging() {
  const b24 = useB24()
  const { batchResults } = useB24Batch()

  /**
   * Выборка всех страниц списочного метода.
   *
   * ⚠ Именно `callList`, а не `call` со `start`: у заказчика до 5 000 лидов и сделок в месяц
   * (замер 2026-09-03), то есть до сотни страниц по 50 записей. `callList` идёт курсором по `ID`
   * и не заказывает подсчёт общего числа записей — на таких объёмах это разница между секундами
   * и десятками секунд.
   */
  async function fetchAll<T>(method: string, params: object): Promise<T[]> {
    const result = await b24.getOrThrow().actions.v2.callList.make<T>({ method, params: plainParams(params) })
    if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
    return (result.getData() ?? []) as T[]
  }

  /**
   * Постраничная выборка, которую МОЖНО бросить на полпути.
   *
   * ⚠ `callList` SDK отмены не знает: начатая выборка идёт до конца, даже если её результат уже
   * никому не нужен. Для фоновой справки блока 7 это ≈ 110 страниц на месяц и ≈ 1 300 на год —
   * каждая смена периода оставляла бы в портале ещё одну многоминутную выборку, и три быстрых
   * клика по периодам исчерпали бы лимит запросов портала для ОСНОВНОГО отчёта. Поэтому здесь
   * свой курсор по `ID` (тот же приём, что у `callList`: `start: -1` отключает подсчёт итога), и
   * между страницами спрашиваем, не устарела ли выборка.
   */
  async function fetchAllUntil<T extends { ID?: string | number }>(
    method: string,
    params: { select: string[], filter: Record<string, unknown>, [extra: string]: unknown },
    stale: () => boolean
  ): Promise<T[]> {
    const rows: T[] = []
    let lastId = 0
    while (!stale()) {
      const result = await b24.getOrThrow().actions.v2.call.make<T[] | { items?: T[] }>({
        method,
        params: plainParams({ ...params, order: { ID: 'ASC' }, filter: { ...params.filter, '>ID': lastId }, start: -1 })
      })
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      // ⚠ Конверт разный: списки CRM отдают `result: [...]`, а `crm.stagehistory.list` —
      // `result: { items: [...] }`. Без этой ветки история приходила бы ПУСТОЙ, каждый лид
      // считался бы без ответа, и блок показал бы «просрочено 100 %» под вечным «ждёт историю».
      const raw = result.getData()?.result as T[] | { items?: T[] } | undefined
      const page = Array.isArray(raw) ? raw : raw?.items
      if (!Array.isArray(page) || page.length === 0) break
      rows.push(...page)
      const last = Number(page[page.length - 1]?.ID)
      if (page.length < 50 || !Number.isFinite(last) || last <= lastId) break
      lastId = last
    }
    return rows
  }

  /**
   * Постраничная выборка СМЕЩЕНИЕМ, пакетами — для выборок, где это заметно быстрее курсора.
   *
   * Замер боевого портала 2026-09-07 (август, полная сверка со чтением курсором): успешные
   * сделки без лида — 9 563 строки, 41 с курсором против 8 с так; лиды для истории — 17 с
   * против 1,3 с. Выигрыш даёт не пакет, а отказ от `order` (см. `listPageCommands`), и курсор
   * от сортировки отказаться не может.
   *
   * ⚠ Историю стадий сюда переводить НЕ СТОИТ: тем же замером 1,3× — метод медленный сам по
   * себе, и семь секунд не окупают потерю устойчивости курсора к записи во время чтения.
   *
   * ⚠ Только для методов, отдающих ПЛОСКИЙ массив. `crm.stagehistory.list` с его конвертом
   * `{ items }` сюда не ходит намеренно, и молча возвращать по нему пустоту нельзя — поэтому
   * чужой конверт роняет выборку, а не превращается в ноль строк.
   */
  async function fetchAllPaged<T extends { ID?: string | number }>(
    method: string,
    params: { select: readonly string[], filter: Record<string, unknown>, [extra: string]: unknown },
    stale: () => boolean
  ): Promise<T[]> {
    // Первая страница отвечает сразу на два вопроса: сколько всего записей и какие в ней строки.
    // Отдельный запрос «только total» стоил бы лишнего круга на каждой выборке.
    const head = await readPage<T>(method, params, 0)
    if (head.total <= LIST_PAGE_SIZE) return dedupeById(head.rows)

    const pages = Math.ceil(head.total / LIST_PAGE_SIZE)
    if (pages > PAGED_MAX_PAGES) {
      throw new Error(`Портал сообщил о ${head.total} записях — больше, чем отчёт читает за раз`)
    }

    const rows: T[] = [...head.rows]
    for (let from = 1; from < pages; from += BATCH_LIMIT) {
      if (stale()) return dedupeById(rows)
      const count = Math.min(BATCH_LIMIT, pages - from)
      const commands = listPageCommands(method, params, from, count)
      const answers = await batchResults<T[] | { items?: T[] }>(commands)

      /**
       * ⛔ Проверяем, что ответила КАЖДАЯ команда. Речь про ПУСТОЙ ответ, а не про отказ: отказ
       * любой команды делает неуспешным весь пакет, и `runChunk` его бросает (повторив, если это
       * лимит интенсивности). Ключ пропадает только когда портал вернул по команде НИЧЕГО — ни
       * строк, ни ошибки.
       *
       * Потерянная страница — это полсотни сделок, не попавших в ВЫРУЧКУ. Число при этом выходит
       * меньше и выглядит совершенно правдоподобно: ровно тот класс дефекта, что стоил отчёту 2
       * двухсот фамилий. Поэтому здесь падаем, а не показываем половину.
       */
      const missing = Object.keys(commands).filter(key => !(key in answers))
      if (missing.length > 0) {
        throw new Error(`Портал не ответил на ${missing.length} из ${count} страниц выборки`)
      }

      for (const [key, answer] of Object.entries(answers)) {
        // ⚠ Чужой ключ — не страница, и `listPageOfKey` отвечает на это -1, а не нулём
        // (`Number('')` — ноль, и ключ без номера лёг бы первой страницей).
        if (listPageOfKey(key) < 0) continue
        rows.push(...expectRows<T>(answer.data, method))
      }
    }

    /**
     * ⚠ Сведение по `ID` обязательно: смещение, в отличие от курсора, не переживает запись во
     * время прохода — вставка между страницами сдвигает окно, и строка приезжает дважды. Дубль
     * здесь идёт в выручку и завышает её молча.
     *
     * ⚠ И поэтому же итог МЕНЬШЕ `total` — это норма, а не признак потери: сведённый дубль как
     * раз и уменьшает счёт. Сверять одно с другим бессмысленно; настоящую потерю ловит проверка
     * полноты пакета выше.
     */
    return dedupeById(rows)
  }

  /**
   * Одна страница списочного метода.
   *
   * ⚠ Общее число записей доступно ТОЛЬКО через `getTotal()`: `AjaxResult.getData()` отдаёт
   * `Object.freeze({ result, time })`, поля `total` там нет вовсе.
   *
   * ⛔ И ноль от `getTotal()` не значит «записей нет». `getTotal()` прогоняет ответ через
   * `Text.toInteger`, то есть отсутствующий `total` превращает в 0 — а `0 <= LIST_PAGE_SIZE`
   * заставило бы выборку вернуть ОДНУ страницу из тысячи и объявить это всей выборкой. Поэтому
   * полная страница при нулевом `total` — это ошибка чтения, а не пустая выборка.
   */
  async function readPage<T>(
    method: string,
    params: { select: readonly string[], filter: Record<string, unknown>, [extra: string]: unknown },
    start: number
  ): Promise<{ rows: T[], total: number }> {
    const result = await b24.getOrThrow().actions.v2.call.make<T[] | { items?: T[] }>({
      method,
      params: plainParams({ ...params, start })
    })
    if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
    const rows = expectRows<T>(result.getData()?.result, method)
    const total = result.getTotal?.() ?? 0
    if (total < rows.length) {
      throw new Error(`Портал не сосчитал записи ${method}: страница есть, а общее число — ${total}`)
    }
    return { rows, total }
  }

  return { fetchAll, fetchAllUntil, fetchAllPaged }
}
