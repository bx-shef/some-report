import { describe, expect, it } from 'vitest'
import { adaptDepartments, sortDepartments, type B24DepartmentRow } from '~/utils/activityAdapter'
import { adaptUserDepartments, type B24UserRow } from '~/utils/b24Adapter'
import { usersInDepartment } from '~/utils/activityLoad'

/**
 * Разбор портальных строк отчёта «Активность пользователей».
 *
 * ⚠ Стенд отдаёт числа СТРОКАМИ и допускает пропущенные поля — ровно как портал. Стенд, который
 * щедрее портала, зеленел бы при сломанном отчёте: этот проект такое уже проходил.
 */

describe('adaptDepartments', () => {
  it('разбирает дерево отделов, как его отдаёт портал', () => {
    const rows: B24DepartmentRow[] = [
      { ID: '1', NAME: 'Генеральный директор', SORT: 500 },
      { ID: '4082', NAME: 'Административный департамент', SORT: 0, PARENT: '1' },
      { ID: '4083', NAME: '1. Офис учредителей', SORT: 500, PARENT: '4082' }
    ]
    expect(adaptDepartments(rows)).toEqual([
      { id: 1, name: 'Генеральный директор', sort: 500 },
      { id: 4082, name: 'Административный департамент', parentId: 1, sort: 0 },
      { id: 4083, name: '1. Офис учредителей', parentId: 4082, sort: 500 }
    ])
  })

  /** ⚠ У корня родителя нет вовсе — поля `parentId` в записи быть не должно, а не `parentId: 0`. */
  it('у корня родителя нет', () => {
    expect(adaptDepartments([{ ID: '1', NAME: 'Компания' }])[0]).not.toHaveProperty('parentId')
    expect(adaptDepartments([{ ID: '1', NAME: 'Компания', PARENT: '0' }])[0]).not.toHaveProperty('parentId')
    expect(adaptDepartments([{ ID: '1', NAME: 'Компания', PARENT: null }])[0]).not.toHaveProperty('parentId')
  })

  /**
   * ⚠ Негодная строка пропускается ЦЕЛИКОМ. Отдел с `NaN` в идентификаторе стал бы узлом, до
   * которого не добраться, и фильтр молча терял бы всех, кто под ним.
   */
  it('строку с нечитаемым идентификатором выбрасывает целиком', () => {
    expect(adaptDepartments([
      { ID: 'мусор', NAME: 'Отдел' },
      { ID: '0', NAME: 'Отдел' },
      { ID: '-5', NAME: 'Отдел' },
      { ID: '7', NAME: 'Настоящий' }
    ])).toEqual([{ id: 7, name: 'Настоящий' }])
  })

  /** ⚠ По номеру человек найдёт отдел в портале, а по прочерку — нет. */
  it('отдел без имени подписан номером', () => {
    expect(adaptDepartments([{ ID: '7', NAME: '   ' }])[0]?.name).toBe('Отдел #7')
    expect(adaptDepartments([{ ID: '7' }])[0]?.name).toBe('Отдел #7')
  })
})

describe('sortDepartments', () => {
  /**
   * ⚠ По имени, а не по `SORT`: у заказчика он почти везде 500, то есть порядок был бы случайным,
   * а выглядел бы осмысленным. В списке из 43 пунктов человек ищет отдел глазами.
   */
  it('порядок по имени, а не по SORT портала', () => {
    const sorted = sortDepartments([
      { id: 1, name: 'Ярославский', sort: 0 },
      { id: 2, name: 'Алексеевский', sort: 900 },
      { id: 3, name: 'Минский', sort: 500 }
    ])
    expect(sorted.map(d => d.name)).toEqual(['Алексеевский', 'Минский', 'Ярославский'])
  })

  it('исходный список не меняется', () => {
    const source = [{ id: 1, name: 'Б' }, { id: 2, name: 'А' }]
    sortDepartments(source)
    expect(source.map(d => d.name)).toEqual(['Б', 'А'])
  })
})

describe('adaptUserDepartments', () => {
  it('читает отделы сотрудника, как их отдаёт портал', () => {
    const rows: B24UserRow[] = [
      { ID: '1', UF_DEPARTMENT: [181] },
      { ID: '2', UF_DEPARTMENT: [4083, 4084] }
    ]
    expect(adaptUserDepartments(rows)).toEqual({ 1: [181], 2: [4083, 4084] })
  })

  /**
   * ⚠ Поле пользовательское (`UF_`): портал волен прислать что угодно. Слепое приведение типа
   * уронило бы фильтр отдела на первом же нестандартном профиле, а негодное значение — это
   * «отделов не знаем», а не поломка.
   */
  it('негодное значение — это «отделов не знаем», а не падение', () => {
    expect(adaptUserDepartments([
      { ID: '1', UF_DEPARTMENT: 'мусор' },
      { ID: '2', UF_DEPARTMENT: null },
      { ID: '3' },
      { ID: '4', UF_DEPARTMENT: [] },
      { ID: '5', UF_DEPARTMENT: [0, -1, 'нет'] }
    ])).toEqual({})
  })

  it('сотрудник без отделов в словарь не попадает вовсе', () => {
    expect(adaptUserDepartments([{ ID: '9', UF_DEPARTMENT: [] }])).not.toHaveProperty('9')
  })

  /**
   * Сквозная проверка: от строки портала до отфильтрованного списка. Здесь ломается связка
   * «портал → фильтр», которую по частям каждый модуль проходит успешно.
   */
  it('от строки портала до фильтра отдела: совместитель попадает в оба', () => {
    const departments = adaptDepartments([
      { ID: '10', NAME: 'Департамент' },
      { ID: '11', NAME: 'Отдел', PARENT: '10' }
    ])
    const byUser = adaptUserDepartments([
      { ID: '1', NAME: 'Один', UF_DEPARTMENT: [11] },
      { ID: '2', NAME: 'Два', UF_DEPARTMENT: [99, 11] },
      { ID: '3', NAME: 'Три', UF_DEPARTMENT: [99] }
    ])
    const users = [1, 2, 3].map(id => ({ id, name: `#${id}`, departmentIds: byUser[String(id)] }))
    expect(usersInDepartment(users, departments, 10).map(u => u.id)).toEqual([1, 2])
    expect(usersInDepartment(users, departments, 99).map(u => u.id)).toEqual([2, 3])
  })
})
