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
      // ⚠ Запоминаем по ИМЕНАМ, а не по пометкам. Имена — это то, ради чего сюда ходят, и они уже
      // прочитаны; сбросить кэш из-за оборвавшегося второго прохода значило бы гонять оба
      // постраничных обхода заново на КАЖДУЮ смену отбора (а её меняют кнопками, по многу раз).
      // Цена решения: пометки «уволен» в такой сессии не появятся до перезагрузки страницы —
      // это заметно меньшее зло, чем десяток лишних запросов на каждое нажатие.
      if (!active.complete) cache = undefined
      // ⚠ Уволенным считаем того, у кого портал ВЕРНУЛ `ACTIVE: false`, а не того, кто пришёл в
      // ответ на запрос с таким фильтром. Разница не теоретическая: не примени портал фильтр (или
      // сериализуй его иначе), второй проход вернул бы тот же штат — и весь отдел оказался бы
      // помечен «уволен». Проверка по самому ответу делает такую подмену невозможной.
      const dismissed = new Set(
        fired.complete
          ? fired.rows.filter(row => row.ACTIVE === false || row.ACTIVE === 'N').map(row => String(Number(row.ID)))
          : []
      )
      return {
        names: { ...adaptUsers(active.rows), ...adaptUsers(fired.rows) },
        dismissed
      }
    })()
    // ⚠ Присваиваем ПОСЛЕ запуска, но это безопасно: тело выше первым делом уходит в `await`,
    // поэтому сброс `cache = undefined` внутри него случится уже после этой строки. Прежде здесь
    // жил ещё и флаг `incomplete` — на случай синхронного броска `getOrThrow()`; бросок этот
    // ловится внутри `readAll`, флаг никогда не срабатывал, и его убрали, чтобы не сторожил
    // несуществующее.
    cache = attempt
    return attempt
  }

  return { fetchUsers }
}
