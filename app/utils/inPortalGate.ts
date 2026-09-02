/**
 * Решение «показывать ли страницу приложения» — чистое ядро (перенесено из `client-bank-alfa-by`).
 *
 * `/app` и `/install` осмысленны только внутри Битрикс24: снаружи нет фрейм-токена, а значит нет и
 * данных. Показать снаружи пустой отчёт хуже, чем объяснить, почему он пуст: пустой отчёт читается
 * как «продаж нет», а это неправда.
 */

export type PortalGateState = 'checking' | 'ok' | 'outside'

export interface PortalGateInput {
  /** Проверка присутствия во фрейме завершилась (`useB24().init()` асинхронный). */
  resolved: boolean
  /** Мы внутри портала Битрикс24. */
  inPortal: boolean
  /** Явный обход для разработки и скриншотов: `?preview=1`. */
  preview: boolean
}

/**
 * Что рендерить. Пока проверка идёт — `checking`: без этого состояния интерфейс мелькнул бы и
 * схлопнулся в заглушку, а это читается как поломка.
 */
export function portalGateState(input: PortalGateInput): PortalGateState {
  if (input.preview) return 'ok'
  if (!input.resolved) return 'checking'
  return input.inPortal ? 'ok' : 'outside'
}

/**
 * Значение `preview` из query роутера означает обход.
 *
 * Берём из РОУТЕРА, а не из `window.location.search`: на гидратации пререндеренной страницы адрес
 * на миг теряет строку запроса, и чтение из `location` возвращало бы пустоту. Голый `?preview`
 * без значения обходом не считается — случайная ссылка не должна открывать неработающий снаружи
 * интерфейс.
 */
export function isPreviewQuery(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isPreviewQuery)
  return value === '1'
}
