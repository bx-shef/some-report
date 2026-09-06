import { adaptUsers, type B24UserRow } from '~/utils/b24Adapter'
import { userListParams } from '~/utils/b24Query'

/** Предел страниц `user.get` — защита от бесконечного `next`, а не от больших порталов. */
const MAX_USER_PAGES = 100

/** Сотрудники портала: имена по идентификатору и кто из них уволен. */
export interface PortalUsers {
  /** id → «Фамилия Имя». Уволенные здесь ТОЖЕ есть — их сделки никуда не делись. */
  names: Record<string, string>
  /** Идентификаторы уволенных (в портале `ACTIVE: false`). */
  dismissed: Set<string>
}

/**
 * Сотрудники портала — общая выборка обоих отчётов.
 *
 * Право `user_brief`; читается страницами по 50 (`user.get`) и запоминается на время жизни
 * страницы: сотрудники за минуту не меняются.
 *
 * ⚠ Проходов ДВА: активные и уволенные. Портал по умолчанию отдаёт только активных, а сделки
 * уволенного остаются — это и есть тот случай, ради которого менеджеры отчёта 2 перечисляются по
 * сделкам, а не по `user.get`. Без второго прохода строка такого сотрудника подписана
 * «Сотрудник #5562»: числа верные, а чьи они — непонятно.
 *
 * ⚠ «Уволен» и «не нашёлся» — РАЗНЫЕ вещи, и второй проход нужен именно чтобы их различать.
 * Уволенного портал отдаёт вместе с фамилией и признаком; «не нашёлся» — это сбой чтения или
 * человек не из штата, и тогда имени нет вовсе. Пометить «уволен» того, чьё имя мы просто не
 * смогли прочитать, — соврать про человека, а не про число.
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
  let cache: Promise<PortalUsers> | undefined

  function fetchUsers(): Promise<PortalUsers> {
    if (cache) return cache
    let incomplete = false
    const attempt = (async () => {
      /** Один проход по сотрудникам: строки и дошли ли мы до конца. */
      async function readAll(active: boolean): Promise<{ rows: B24UserRow[], complete: boolean }> {
        const rows: B24UserRow[] = []
        try {
          for (let start = 0, pages = 0; pages < MAX_USER_PAGES; pages++) {
            const result = await b24.getOrThrow().actions.v2.call.make<B24UserRow[]>({
              method: 'user.get',
              params: userListParams(start, active)
            })
            if (!result.isSuccess) return { rows, complete: false }
            const data = result.getData() as { result?: unknown, next?: unknown } | undefined
            if (!Array.isArray(data?.result)) return { rows, complete: false }
            rows.push(...(data.result as B24UserRow[]))
            if (typeof data.next !== 'number' || data.result.length === 0) return { rows, complete: true }
            start = data.next
          }
        } catch {
          // См. шапку: список — удобство подписи, а не данные отчёта.
          return { rows, complete: false }
        }
        // Страницы кончились по предохранителю — значит, прочитали не всё.
        return { rows, complete: false }
      }

      const active = await readAll(true)
      // ⚠ Оборвался первый проход — второго не делаем. Самая частая причина здесь одна: права
      // `user_brief` нет, и запрос уволенных упрётся в тот же отказ. Список всё равно не
      // запомнится и будет перечитан на следующей выборке — незачем тратить на это второй
      // постраничный обход.
      const fired = active.complete ? await readAll(false) : { rows: [] as B24UserRow[], complete: false }
      // ⚠ Неполный проход снимается ДВУМЯ способами, и оба нужны. `cache = undefined` работает,
      // когда мы дошли сюда после `await`, то есть уже ПОСЛЕ присваивания `cache = attempt`.
      // А если `getOrThrow()` бросит СИНХРОННО (SDK ещё не инициализирован), всё тело выполнится
      // ДО этого присваивания — сброс не сработал бы, и пустой список запомнился бы навсегда:
      // фильтр по менеджеру остался бы закрытым, а матрица подписанной «Сотрудник #17» до
      // перезагрузки страницы. Для этого случая и нужен флаг.
      if (!active.complete || !fired.complete) {
        incomplete = true
        cache = undefined
      }
      // ⚠ Помечаем уволенными ТОЛЬКО тех, кого портал отдал во втором проходе. Оборвался проход —
      // пометок не будет вовсе, и это правильная деградация: подпись «уволен» на работающем
      // сотруднике хуже, чем её отсутствие на уволенном.
      const dismissed = new Set(fired.complete ? Object.keys(adaptUsers(fired.rows)) : [])
      return {
        names: { ...adaptUsers(active.rows), ...adaptUsers(fired.rows) },
        dismissed
      }
    })()
    if (incomplete) return attempt
    cache = attempt
    return attempt
  }

  return { fetchUsers }
}
