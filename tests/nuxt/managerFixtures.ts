import type { ManagerLoadReport } from '~/types/managers'
import { buildManagerLoad, cellKey, companyKey, COMPANY_UNSET, COMPANY_UNSET_LABEL, pairKey, totalKey } from '~/utils/managerLoad'

/**
 * Готовый отчёт «Сделки по менеджерам» для тестов экрана.
 *
 * ⚠ Собирается ТЕМ ЖЕ ядром, что и живой: тест на вёрстку не должен изобретать свои итоги — иначе
 * он зелёный на числах, которых отчёт никогда не покажет.
 *
 * Что здесь есть намеренно: две компании и «моя компания не указана», строка «вне таблицы» в первой * компании (итог 25 при сумме строк 20) и пустые клетки.
 */
export function buildFixtureReport(): ManagerLoadReport {
  return buildManagerLoad({
    companies: [
      { id: 10, name: 'Минск' },
      { id: 20, name: 'Гомель' },
      { id: COMPANY_UNSET, name: COMPANY_UNSET_LABEL }
    ],
    managers: [
      { id: 1, name: 'Иванов Иван' },
      { id: 2, name: 'Петров Пётр' }
    ],
    stages: [
      { id: 'NEW', name: 'Новая', semantic: 'P' },
      { id: '1', name: 'Выставлен счёт', semantic: 'P' }
    ],
    totals: {
      [totalKey()]: 40,
      [companyKey(10)]: 25,
      [companyKey(20)]: 10,
      [companyKey(COMPANY_UNSET)]: 5,
      [pairKey(10, 1)]: 12,
      [pairKey(10, 2)]: 8,
      [pairKey(20, 1)]: 10,
      [pairKey(COMPANY_UNSET, 2)]: 5,
      [cellKey(10, 1, 'NEW')]: 5,
      [cellKey(10, 1, '1')]: 7,
      [cellKey(10, 2, 'NEW')]: 8,
      [cellKey(20, 1, '1')]: 10,
      [cellKey(COMPANY_UNSET, 2, 'NEW')]: 5
    }
  })
}
