import type { ActivityFilters, ActivityRow, CallDirection, DeedKind } from '~/types/activity'
import type { DrillSliderPayload } from '~/utils/drillSlider'
import { NO_USER_ID } from '~/utils/activityLoad'
import { callDrillFilter, deedFilter, leadCountFilter, overdueFilter, type CallPart } from '~/utils/activityQuery'

/**
 * Что стоит за каждым кликабельным числом отчёта «Активность пользователей».
 *
 * ⛔ Главное здесь одно: условие списка строят ТЕ ЖЕ функции, что задавали порталу вопрос
 * «сколько» (`activityQuery.ts`). Не «такое же условие», а буквально то же — поэтому список не
 * может разойтись с числом над ним, пока они не разойдутся у самого портала. Это сильнее любой
 * сверки: в отчёте по лидам условие числа и условие списка живут в разных местах и однажды уже
 * разъезжались.
 *
 * ⚠ Некликабельны три вещи, и все три — по правилу «список обязан сходиться с числом»:
 *
 * 1. **Длительность и средний разговор.** Это не количество записей: под «6 ч 37 мин» открылся бы
 *    список из 181 строки, и сверить их между собой нечем.
 * 2. **Итоговая строка таблицы.** Итог — сумма ПОКАЗАННЫХ сотрудников, а тот же фильтр без
 *    условия по человеку вернул бы весь портал. Под фильтром отдела это расхождение в разы, и
 *    выглядело бы оно как ошибка отчёта.
 * 3. **Дела и лиды строки, которых отчёт не спрашивал** (`deedsKnown: false`). Там на экране
 *    прочерк, а не число: кликать не по чему.
 */

/** По какому числу нажали. */
export type ActivityCell
  = | { kind: 'talks', direction?: CallDirection }
    | { kind: 'failed' }
    | { kind: 'tooShort' }
    | { kind: 'deed', deed: DeedKind, direction?: CallDirection }
    | { kind: 'overdue' }
    | { kind: 'lead', outcome: 'created' | 'won' | 'lost' }

/** Подписи чисел — те же слова, что стоят в таблице: заголовок списка повторяет то, по чему нажали. */
const TITLES = {
  talks: 'Разговоры',
  talksIn: 'Входящие разговоры',
  talksOut: 'Исходящие разговоры',
  failed: 'Не дозвонились',
  tooShort: 'Короткие разговоры',
  emailIn: 'Входящие письма',
  emailOut: 'Исходящие письма',
  email: 'Письма',
  meeting: 'Встречи',
  task: 'Задачи',
  overdue: 'Просроченные дела',
  created: 'Созданные лиды',
  won: 'Успешно закрытые лиды',
  lost: 'Проваленные лиды'
} as const

/** Как назвать список звонков. */
function callTitle(cell: Extract<ActivityCell, { kind: 'talks' | 'failed' | 'tooShort' }>): string {
  if (cell.kind === 'failed') return TITLES.failed
  if (cell.kind === 'tooShort') return TITLES.tooShort
  if (cell.direction === 'in') return TITLES.talksIn
  if (cell.direction === 'out') return TITLES.talksOut
  return TITLES.talks
}

/** Как назвать список дел. */
function deedTitle(cell: Extract<ActivityCell, { kind: 'deed' }>): string {
  if (cell.deed !== 'email') return cell.deed === 'meeting' ? TITLES.meeting : TITLES.task
  if (cell.direction === 'in') return TITLES.emailIn
  if (cell.direction === 'out') return TITLES.emailOut
  return TITLES.email
}

/**
 * Условие списка за числом.
 *
 * @param row строка, по числу которой нажали
 * @param cell какое именно это число
 * @param filters отбор, под которым посчитаны числа на экране (НЕ выбранный в панели)
 * @returns нагрузку слайдера или `undefined`, если за этим числом списка нет
 *
 * ⚠ Отбор берётся ПРИМЕНЁННЫЙ, а не выбранный: пока идёт новая выборка, в панели уже стоит новый
 * период, а на экране — числа старого. Список по выбранному открыл бы записи, которых в таблице
 * ещё нет.
 */
export function activityDrillPayload(
  row: ActivityRow,
  cell: ActivityCell,
  filters: ActivityFilters,
  total: number
): DrillSliderPayload | undefined {
  // ⚠ Дела и лиды строки, которой их не спрашивали, некликабельны: на экране там прочерк.
  // Звонки при этом кликабельны — они у такой строки настоящие.
  if (!row.deedsKnown && (cell.kind === 'deed' || cell.kind === 'overdue' || cell.kind === 'lead')) return undefined

  const who = ` · ${row.userName}`
  const period = filters.period

  switch (cell.kind) {
    case 'talks':
    case 'failed':
    case 'tooShort': {
      const part: CallPart = cell.kind
      return {
        entity: 'call',
        title: `${callTitle(cell)}${who}`,
        filter: callDrillFilter(period, part, filters.thresholdSeconds, {
          userId: row.userId,
          ...(cell.kind === 'talks' && cell.direction ? { direction: cell.direction } : {})
        }) as DrillSliderPayload['filter'],
        total
      }
    }
    case 'deed':
      return {
        entity: 'activity',
        activityScope: 'created',
        title: `${deedTitle(cell)}${who}`,
        filter: deedFilter(period, row.userId, cell.deed, cell.direction) as DrillSliderPayload['filter'],
        total
      }
    case 'overdue':
      return {
        entity: 'activity',
        // ⚠ Строка списка возьмёт СРОК, а не дату создания: число посчитано по сроку и без нижней
        // границы периода — иначе список с датами трёхлетней давности встал бы под ним без
        // объяснения.
        activityScope: 'overdue',
        title: `${TITLES.overdue}${who}`,
        filter: overdueFilter(period, row.userId) as DrillSliderPayload['filter'],
        total
      }
    case 'lead':
      return {
        entity: 'lead',
        title: `${TITLES[cell.outcome]}${who}`,
        filter: leadCountFilter(period, row.userId, cell.outcome) as DrillSliderPayload['filter'],
        total
      }
  }
}

/**
 * Есть ли за числом список вообще.
 *
 * ⚠ Отдельная функция, а не «попробовать собрать нагрузку»: экран решает, рисовать ли кнопку, на
 * КАЖДОЕ число таблицы (сотня строк на тринадцать столбцов), и собирать ради этого сотни объектов
 * фильтра было бы работой на выброс при каждой перерисовке.
 *
 * ⚠ Строка «Без сотрудника» кликабельна по звонкам: `PORTAL_USER_ID` пуст — это ЗНАЧЕНИЕ фильтра,
 * и портал по нему отвечает теми же записями, что посчитало ядро.
 */
export function hasActivityDrill(row: ActivityRow, cell: ActivityCell, total: number): boolean {
  if (total <= 0) return false
  if (row.deedsKnown) return true
  return cell.kind === 'talks' || cell.kind === 'failed' || cell.kind === 'tooShort'
}

/** Строка «Без сотрудника» — у неё звонки есть, а дел не спрашивали. */
export function isUnassignedRow(row: ActivityRow): boolean {
  return row.userId === NO_USER_ID
}
