import type { CategoryRef, StageRef } from '~/types/managers'
import type { B24StatusRow } from '~/utils/b24Adapter'

/**
 * Адаптер портала для отчёта «Сделки по менеджерам»: сырые строки справочников → типы отчёта.
 *
 * Отдельным модулем, а не внутри композабла, по той же причине, что и `b24Adapter.ts` у отчёта по
 * лидам: это чистые функции без сети и реактивности, и правило проекта — всё в `utils` под
 * тестом. Ошибка здесь не роняет отчёт, а тихо подписывает колонку не тем именем.
 */

/** Строка справочника направлений (`crm.category.list`). */
export interface B24CategoryRow {
  id?: unknown
  name?: unknown
  isDefault?: unknown
}

/**
 * Справочник стадий портала → колонки отчёта.
 *
 * ⚠ Семантику берём из справочника (`SEMANTICS`), а не из кода стадии: у заказчика в одном
 * направлении одиннадцать провальных стадий с кодами вида `2`, `UC_CVXNKM`, `C4:LOSE`, и зашитый
 * список посчитал бы чужую воронку. Пустая семантика — «в работе», так её отдаёт портал.
 */
export function adaptStages(rows: readonly B24StatusRow[]): StageRef[] {
  return rows
    .filter(row => typeof row?.STATUS_ID === 'string' && row.STATUS_ID !== '')
    .map(row => ({
      id: row.STATUS_ID,
      // Имя пустое — печатаем код: по нему стадию хотя бы можно найти в CRM.
      name: typeof row.NAME === 'string' && row.NAME.trim() ? row.NAME : row.STATUS_ID,
      semantic: row.SEMANTICS === 'S' ? 'S' : row.SEMANTICS === 'F' ? 'F' : 'P'
    }))
}

/** Стадии направления → «код: имя» для списка по клику: там стадия печатается словами. */
export function stageNames(stages: readonly StageRef[]): Record<string, string> {
  return Object.fromEntries(stages.map(stage => [stage.id, stage.name]))
}

/**
 * Справочник направлений портала → список для фильтра.
 *
 * ⚠ Направление 0 («Общее») — полноправное значение, а не «фильтра нет»: поэтому пропускаем
 * `id >= 0`, а не `id > 0`, как в отчёте по лидам, где нулевое направление читается отдельно.
 */
export function adaptCategories(rows: readonly B24CategoryRow[]): CategoryRef[] {
  return rows
    .map(row => ({
      id: Number(row?.id),
      name: typeof row?.name === 'string' && row.name.trim() ? row.name : `Направление #${Number(row?.id)}`
    }))
    .filter(row => Number.isFinite(row.id) && row.id >= 0)
}
