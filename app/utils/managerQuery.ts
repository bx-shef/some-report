import type { ManagerFilters } from '~/types/managers'
import type { BatchCommand } from '~/utils/b24Query'
import { countCommand, periodFilter } from '~/utils/b24Query'
import { cellKey, companyKey, companyStageKey, pairKey, scopeSemantic, totalKey } from '~/utils/managerLoad'

/**
 * Запросы отчёта «Сделки по менеджерам»: что именно спрашиваем у портала.
 *
 * ⚠ Строк отчёт не читает вообще. На боевом портале 698 тысяч сделок, из них открытых 15 тысяч
 * (замер 2026-09-04, `docs/PORTAL.md`): строками месяц выбирался бы минутами. Вместо этого —
 * ВОПРОСЫ «сколько», по одному на клетку матрицы, пакетами по 50. Каждый такой вопрос портал
 * считает индексом за миллисекунды: 50 счётчиков открытых сделок — 0,26 с.
 *
 * Модуль чистый и потому под тестом: ошибка в фильтре не роняет отчёт, а тихо меняет все числа.
 */

/** Поле сделки «Моя компания» (`MYCOMPANY_ID`), а НЕ компания-клиент (`COMPANY_ID`). */
export const COMPANY_FIELD = 'MYCOMPANY_ID'

/** Поле ответственного за сделку. */
export const MANAGER_FIELD = 'ASSIGNED_BY_ID'

/**
 * Фильтр отбора БЕЗ «моей компании»: направление, охват, период создания.
 *
 * ⚠ `CATEGORY_ID` — обязательно одно направление. Стадии у направлений СВОИ (у заказчика их
 * четыре, и «Новая» в каждом со своим кодом), поэтому колонки таблицы имеют смысл только внутри
 * одного направления. Направление 0 — «Общее», это тоже значение фильтра, а не «все».
 *
 * ⚠ Отдельная функция нужна ровно для одного: ПЕРЕЧИСЛЕНИЯ «моих компаний». Спрашивать список
 * компаний под уже выбранной компанией значит получить список из одного пункта — и фильтр в
 * панели схлопнулся бы до того значения, которое человек только что выбрал, без пути назад.
 */
export function managerScanFilter(filters: ManagerFilters): Record<string, unknown> {
  const semantic = scopeSemantic(filters.scope)
  return {
    CATEGORY_ID: filters.categoryId,
    ...(semantic ? { STAGE_SEMANTIC_ID: semantic } : {}),
    ...periodFilter(filters.period)
  }
}

/**
 * Базовый фильтр отбора: то же плюс «моя компания», когда она выбрана.
 *
 * ⚠ `companyId: 0` — не «не задано», а ЗНАЧЕНИЕ: портал по `MYCOMPANY_ID: 0` отдаёт сделки с
 * незаполненным полем (проверено на боевом портале). Поэтому сравнение именно с `undefined`:
 * привычное `filters.companyId ? … : …` молча превратило бы «без моей компании» во «все».
 */
export function managerDealFilter(filters: ManagerFilters): Record<string, unknown> {
  return {
    ...managerScanFilter(filters),
    ...(filters.companyId === undefined ? {} : { [COMPANY_FIELD]: filters.companyId })
  }
}

/** Справочник стадий одного направления. Направление 0 живёт под именем `DEAL_STAGE`, без суффикса. */
export function stageListParams(categoryId: number) {
  return { filter: { ENTITY_ID: categoryId > 0 ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE' } }
}

/** Названия «моих компаний» по идентификаторам, которые встретились у сделок. */
export function companyNamesParams(ids: readonly number[]) {
  return { select: ['ID', 'TITLE'], filter: { ID: [...ids] } }
}

/**
 * Цепочка «следующее значение поля» — перечисление РАЗНЫХ значений `ASSIGNED_BY_ID` или
 * `MYCOMPANY_ID` среди сделок отбора.
 *
 * Как это работает: команда просит ОДНУ сделку с наименьшим значением поля больше предыдущего.
 * В пакете команды ссылаются друг на друга (`$result[...]`), поэтому 50 разных значений
 * приезжают одним HTTP-запросом за ~2,8 с — вместо 50 запросов по 0,25 с.
 *
 * ⚠ Зачем вообще перечислять, а не взять список сотрудников из `user.get`: сделки уволенных.
 * Их в портале годами, `user.get` их не отдаёт (фильтр по активным), и матрица молча теряла бы
 * целые столбцы работы. Перечисление идёт по САМИМ СДЕЛКАМ и потому точное.
 *
 * ⚠ ГЛАВНАЯ ловушка: когда значения кончились, команда возвращает пустой ответ, ссылка
 * `$result[...]` у следующей не разрешается, фильтр `>ПОЛЕ` становится пустым — и цепочка
 * НАЧИНАЕТСЯ СНАЧАЛА. Ошибки при этом нет: портал отдаёт первое значение по кругу (проверено на
 * боевом портале). Поэтому читать ответ можно только `readDistinctChain`, который обрывается на
 * первом пустом ответе и на первом значении, которое не больше предыдущего.
 */
export function distinctChainBatch(
  field: string,
  base: Record<string, unknown>,
  size: number,
  /** С какого значения продолжать: 0 — с начала, иначе последнее прочитанное. */
  after = 0,
  prefix = 'q'
): Record<string, BatchCommand> {
  const commands: Record<string, BatchCommand> = {}
  for (let i = 0; i < size; i++) {
    commands[`${prefix}${i}`] = {
      method: 'crm.deal.list',
      params: {
        select: ['ID', field],
        order: { [field]: 'ASC' },
        // ⚠ `start: -1` — «быстрый режим»: портал не считает общее число записей. Сортировку он
        // при этом соблюдает (проверено на боевом портале 2026-09-05: те же значения, что при
        // `start: 0`), а разница во времени восьмикратная — 0,6 с против 4,5 с на пакет команд по
        // множеству в 616 тысяч сделок. Считать итог здесь не нужно: берём одну первую строку.
        start: -1,
        filter: { ...base, [`>${field}`]: i === 0 ? after : `$result[${prefix}${i - 1}][0][${field}]` }
      }
    }
  }
  return commands
}

/** Строки ответа цепочки по ключам команд — в том же порядке, что и команды. */
export function readDistinctChain(
  rows: Record<string, Array<Record<string, unknown>> | undefined>,
  field: string,
  size: number,
  prefix = 'q'
): number[] {
  const out: number[] = []
  let previous = -Infinity
  for (let i = 0; i < size; i++) {
    const value = Number(rows[`${prefix}${i}`]?.[0]?.[field])
    // Пустой ответ — значения кончились. Всё, что дальше, — цепочка по второму кругу (см. выше).
    if (!Number.isFinite(value)) break
    if (value <= previous) break
    out.push(value)
    previous = value
  }
  return out
}

/** Один вопрос «сколько»: под каким ключом ответ и по какому фильтру считать. */
export interface CountRequest {
  key: string
  filter: Record<string, unknown>
}

/** Итог отбора и итог каждой «моей компании» — по ним считаются остатки «вне строк». */
export function companyCountRequests(companyIds: readonly number[], base: Record<string, unknown>): CountRequest[] {
  return [
    { key: totalKey(), filter: { ...base } },
    ...companyIds.map(id => ({ key: companyKey(id), filter: { ...base, [COMPANY_FIELD]: id } }))
  ]
}

/**
 * Итоги колонок: сколько сделок «моей компании» на каждой стадии.
 *
 * ⚠ Отдельные вопросы порталу, а не суммы клеток: в сумму не попали бы сделки без ответственного
 * (строка «вне таблицы»), и клик по итогу колонки открывал бы список длиннее числа над ним.
 * Стоят они дёшево — компаний единицы, стадий полтора десятка.
 */
export function companyStageCountRequests(
  companyIds: readonly number[],
  stageIds: readonly string[],
  base: Record<string, unknown>
): CountRequest[] {
  const out: CountRequest[] = []
  for (const companyId of companyIds) {
    for (const stageId of stageIds) {
      out.push({ key: companyStageKey(companyId, stageId), filter: { ...base, [COMPANY_FIELD]: companyId, STAGE_ID: stageId } })
    }
  }
  return out
}

/**
 * Итог каждой пары «моя компания + менеджер».
 *
 * ⚠ Спрашиваем ВСЕ пары, а не только «менеджер работает в этой компании»: портал не знает, к
 * какой компании относится сотрудник, а сделки одного менеджера бывают в двух. Пар немного — на
 * боевом портале 70 менеджеров и 2 компании (`docs/PORTAL.md`), — а пустые пары дальше отсекаются
 * и не порождают вопросов по стадиям, которых было бы в шестнадцать раз больше.
 */
export function pairCountRequests(
  companyIds: readonly number[],
  managerIds: readonly number[],
  base: Record<string, unknown>
): CountRequest[] {
  const out: CountRequest[] = []
  for (const companyId of companyIds) {
    for (const managerId of managerIds) {
      out.push({ key: pairKey(companyId, managerId), filter: { ...base, [COMPANY_FIELD]: companyId, [MANAGER_FIELD]: managerId } })
    }
  }
  return out
}

/** Пара «моя компания + менеджер», у которой есть хотя бы одна сделка. */
export interface LoadPair {
  companyId: number
  managerId: number
}

/** Клетки матрицы: сколько сделок у пары на каждой стадии охвата. */
export function cellCountRequests(
  pairs: readonly LoadPair[],
  stageIds: readonly string[],
  base: Record<string, unknown>
): CountRequest[] {
  const out: CountRequest[] = []
  for (const pair of pairs) {
    for (const stageId of stageIds) {
      out.push({
        key: cellKey(pair.companyId, pair.managerId, stageId),
        filter: { ...base, [COMPANY_FIELD]: pair.companyId, [MANAGER_FIELD]: pair.managerId, STAGE_ID: stageId }
      })
    }
  }
  return out
}

/**
 * Вопросы «сколько» → команды пакета.
 *
 * ⚠ Ключи команд — порядковые (`n0`, `n1`, …), а не ключи счётчиков: в ключ счётчика входит код
 * стадии вида `C4:LOSE`, и класть такое в имя команды пакета значит зависеть от того, как портал
 * разбирает своё же имя. Соответствие «команда → счётчик» возвращается отдельной картой.
 */
export function countBatch(requests: readonly CountRequest[]): {
  commands: Record<string, BatchCommand>
  keyByCommand: Record<string, string>
} {
  const commands: Record<string, BatchCommand> = {}
  const keyByCommand: Record<string, string> = {}
  requests.forEach((request, index) => {
    const name = `n${index}`
    // Форму вопроса «сколько» держит `countCommand` (`b24Query.ts`) — там же и объяснение, почему
    // `start: 0`: при `start: -1` портал не считает `total` вовсе. Своя копия здесь означала бы,
    // что однажды один отчёт починят, а второй молча начнёт возвращать нули по каждой клетке.
    commands[name] = countCommand('crm.deal.list', request.filter)
    keyByCommand[name] = request.key
  })
  return { commands, keyByCommand }
}

/** Ответы пакета (`total` по имени команды) → счётчики по ключам ядра. */
export function collectTotals(
  totals: Record<string, number>,
  keyByCommand: Record<string, string>,
  into: Record<string, number> = {}
): Record<string, number> {
  for (const [name, key] of Object.entries(keyByCommand)) {
    const value = totals[name]
    if (Number.isFinite(value)) into[key] = (into[key] ?? 0) + Number(value)
  }
  return into
}

/**
 * Фильтр списка сделок за одним числом матрицы — тем же условием, что дало число.
 *
 * Клетка: компания + менеджер + стадия. Строка «Всего»: компания + менеджер. Итог компании —
 * одна компания. Ничего лишнего сюда не добавляется, иначе список разошёлся бы с числом над ним.
 */
export function cellDealFilter(base: Record<string, unknown>, cell: { companyId?: number, managerId?: number, stageId?: string }): Record<string, unknown> {
  return {
    ...base,
    ...(cell.companyId === undefined ? {} : { [COMPANY_FIELD]: cell.companyId }),
    ...(cell.managerId === undefined ? {} : { [MANAGER_FIELD]: cell.managerId }),
    ...(cell.stageId === undefined ? {} : { STAGE_ID: cell.stageId })
  }
}
