import type { DepartmentRef } from '~/types/activity'

/**
 * Портальные строки отчёта «Активность пользователей» → нормализованные записи.
 *
 * Всё портальное живёт здесь, как в `b24Adapter.ts` у отчёта 1: ядро не должно знать ни имён полей
 * REST, ни того, что портал отдаёт числа строками.
 */

/** Сырая строка `department.get`. */
export interface B24DepartmentRow {
  ID?: string | number
  NAME?: string | null
  /** Родительский отдел. У корня поля нет вовсе. */
  PARENT?: string | number | null
  SORT?: string | number | null
}

/**
 * Отделы портала → дерево для фильтра.
 *
 * ⚠ Разбираем ПРОВЕРЯЯ: негодная строка пропускается целиком, а не подставляет `NaN` в дерево.
 * Отдел с нечитаемым идентификатором в поддереве стал бы узлом, до которого не добраться, — и
 * фильтр молча терял бы всех, кто под ним.
 *
 * ⚠ Отдел БЕЗ имени подписываем номером, а не прочерком: по номеру человек найдёт отдел в портале.
 */
export function adaptDepartments(rows: readonly B24DepartmentRow[]): DepartmentRef[] {
  const out: DepartmentRef[] = []
  for (const row of rows) {
    const id = Number(row?.ID)
    if (!Number.isFinite(id) || id <= 0) continue
    const parentId = Number(row?.PARENT)
    const sort = Number(row?.SORT)
    out.push({
      id,
      name: (row?.NAME ?? '').trim() || `Отдел #${id}`,
      ...(Number.isFinite(parentId) && parentId > 0 ? { parentId } : {}),
      ...(Number.isFinite(sort) ? { sort } : {})
    })
  }
  return out
}

/**
 * Порядок отделов в фильтре: по имени.
 *
 * ⚠ Не по `SORT` портала и не по идентификатору. `SORT` у заказчика почти везде 500 — то есть
 * порядок был бы случайным, а выглядел бы осмысленным; идентификатор — это про время создания
 * отдела. В списке из 43 пунктов человек ищет отдел глазами, и алфавит здесь единственное, что
 * ему помогает.
 */
export function sortDepartments(departments: readonly DepartmentRef[]): DepartmentRef[] {
  return [...departments].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}
