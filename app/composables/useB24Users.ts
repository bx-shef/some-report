import { adaptUsers, type B24UserRow } from '~/utils/b24Adapter'
import { userListParams } from '~/utils/b24Query'

/** Предел страниц `user.get` — защита от бесконечного `next`, а не от больших порталов. */
const MAX_USER_PAGES = 100

/**
 * Сотрудники портала (id → «Фамилия Имя») — общая выборка обоих отчётов.
 *
 * Право `user_brief`; читается страницами по 50 (`user.get`) и запоминается на время жизни
 * страницы: сотрудники за минуту не меняются.
 *
 * ⚠ Ошибка здесь — НЕ ошибка отчёта. Числа от списка не зависят: в отчёте по лидам без него
 * закрыт только выбор менеджера, в отчёте по менеджерам строки просто подписаны «Сотрудник #17»
 * вместо фамилии. Поэтому ошибку глушим и отдаём то, что успели прочитать.
 *
 * ⚠ Неполный проход (обрыв, лимит запросов, нет права) НЕ запоминаем: иначе моргнувшая сеть
 * оставила бы отчёт без фамилий до перезагрузки страницы.
 */
export function useB24Users() {
  const b24 = useB24()
  let cache: Promise<Record<string, string>> | undefined

  function fetchUsers(): Promise<Record<string, string>> {
    if (cache) return cache
    const attempt = (async () => {
      const rows: B24UserRow[] = []
      let complete = false
      try {
        for (let start = 0, pages = 0; pages < MAX_USER_PAGES; pages++) {
          const result = await b24.getOrThrow().actions.v2.call.make<B24UserRow[]>({ method: 'user.get', params: userListParams(start) })
          if (!result.isSuccess) break
          const data = result.getData() as { result?: unknown, next?: unknown } | undefined
          if (!Array.isArray(data?.result)) break
          rows.push(...(data.result as B24UserRow[]))
          if (typeof data.next !== 'number' || data.result.length === 0) {
            complete = true
            break
          }
          start = data.next
        }
      } catch {
        // См. шапку: список — удобство подписи, а не данные отчёта.
      }
      if (!complete) cache = undefined
      return adaptUsers(rows)
    })()
    cache = attempt
    return attempt
  }

  return { fetchUsers }
}
