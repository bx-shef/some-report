import type { CategoryRef, ManagerFilters, ManagerLoadReport, ManagerRef, OfficeRef, StageRef } from '~/types/managers'
import type { ReportDictionaries } from '~/types/report'
import { statusNames, type B24StatusRow } from '~/utils/b24Adapter'
import { categoryListParams, dictionaryBatch } from '~/utils/b24Query'
import {
  buildManagerLoad,
  emptyManagerLoad,
  OFFICE_UNSET,
  OFFICE_UNSET_LABEL,
  pairKey,
  stagesForScope
} from '~/utils/managerLoad'
import {
  cellCountRequests,
  collectTotals,
  companyNamesParams,
  countBatch,
  distinctChainBatch,
  MANAGER_FIELD,
  managerDealFilter,
  officeCountRequests,
  OFFICE_FIELD,
  pairCountRequests,
  readDistinctChain,
  stageListParams,
  type LoadPair
} from '~/utils/managerQuery'
import { buildMockManagerReport, MOCK_CATEGORIES, MOCK_MANAGERS, MOCK_STAGES } from '~/utils/mockManagers'

/**
 * Источник данных отчёта «Сделки по менеджерам».
 *
 * Слои те же, что в отчёте по лидам: `managerQuery.ts` знает, что спросить, `managerLoad.ts` —
 * как посчитать, здесь только склейка, состояния загрузки и защита от гонки ответов.
 *
 * Порядок выборки (замер по боевому порталу 2026-09-05, ≈ 12 с на направление):
 * 1. направления и стадии выбранного направления — справочники;
 * 2. ПЕРЕЧИСЛЕНИЕ офисов и менеджеров цепочкой в пакете — по самим сделкам, а не по списку
 *    сотрудников: у уволенных сделки остаются, а `user.get` их не отдаёт;
 * 3. счётчики «сколько» по офисам и парам «офис + менеджер»;
 * 4. счётчики по клеткам — только для непустых пар (иначе вопросов было бы в разы больше);
 * 5. имена: компании — из CRM, сотрудники — из `user.get` (право `user_brief`).
 *
 * ⚠ Вне портала остаётся демонстрационный набор, и `isDemo` обязан это показывать: отчёт, молча
 * выдающий чужие числа за данные клиента, хуже отсутствующего отчёта.
 */

/** Команд в одной цепочке перечисления. Ровно предел пакета: ссылки `$result` живут внутри него. */
export const CHAIN_SIZE = 50

/** Сколько цепочек подряд читаем менеджеров: 10 × 50 = 500 человек на направление. */
export const MANAGER_CHAIN_PAGES = 10

/** Офисов в портале единицы, но берём с запасом: 5 × 10 = 50. */
export const OFFICE_CHAIN_SIZE = 10
export const OFFICE_CHAIN_PAGES = 5

/** Умолчание отбора: направление по умолчанию портала, сделки в работе, за всё время. */
export const DEFAULT_MANAGER_FILTERS: ManagerFilters = { categoryId: 0, scope: 'in-work' }

/** Строка справочника направлений (`crm.category.list`). */
interface B24CategoryRow {
  id?: unknown
  name?: unknown
  isDefault?: unknown
}

/** Справочник стадий портала → колонки отчёта. Семантику берём у портала, а не из кода стадии. */
export function adaptStages(rows: readonly B24StatusRow[]): StageRef[] {
  return rows
    .filter(row => typeof row?.STATUS_ID === 'string' && row.STATUS_ID !== '')
    .map(row => ({
      id: row.STATUS_ID,
      name: typeof row.NAME === 'string' && row.NAME.trim() ? row.NAME : row.STATUS_ID,
      semantic: row.SEMANTICS === 'S' ? 'S' : row.SEMANTICS === 'F' ? 'F' : 'P'
    }))
}

/** Стадии направления → «код: имя» для списка по клику: там стадия печатается словами. */
export function stageNames(stages: readonly StageRef[]): Record<string, string> {
  return Object.fromEntries(stages.map(stage => [stage.id, stage.name]))
}

/** Справочник направлений портала → список для фильтра. */
export function adaptCategories(rows: readonly B24CategoryRow[]): CategoryRef[] {
  return rows
    .map(row => ({ id: Number(row?.id), name: typeof row?.name === 'string' && row.name.trim() ? row.name : `Направление #${Number(row?.id)}` }))
    .filter(row => Number.isFinite(row.id) && row.id >= 0)
}

export function useManagerReport() {
  const b24 = useB24()
  const { batchRows, batchTotals } = useB24Batch()
  const { fetchUsers } = useB24Users()

  const source = ref<'mock' | 'portal'>('mock')
  const isDemo = computed(() => source.value === 'mock')
  const report = ref<ManagerLoadReport>(emptyManagerLoad())
  /** Направления портала — список для фильтра. До первой выборки пуст. */
  const categories = ref<CategoryRef[]>([])
  /** ВСЕ стадии применённого направления: по ним подписан охват и видно, сколько их всего. */
  const stages = ref<StageRef[]>([])
  /** Отбор, под которым посчитаны числа на экране, — не тот, что выбран в панели. */
  const filters = ref<ManagerFilters>(DEFAULT_MANAGER_FILTERS)
  /**
   * Справочники для подписей списка по клику: источники сделок, имена стадий направления и
   * сотрудники. Сам отчёт в них не нуждается — числа считает портал, — но список сделок без них
   * печатал бы `PROCES_DELIVERY` и `SOURCE_1` вместо слов.
   */
  const dictionaries = ref<ReportDictionaries>({ sources: {}, junkReasons: {}, lossReasons: {} })
  const pending = ref(false)
  const error = ref<string | undefined>(undefined)
  /** Что делаем прямо сейчас — выборка идёт секунд десять, и молчать всё это время нельзя. */
  const step = ref<string | undefined>(undefined)
  /**
   * Перечисление менеджеров упёрлось в предел (`MANAGER_CHAIN_PAGES`). Молчать нельзя: часть
   * сделок окажется в остатке «вне строк», и человек должен знать, почему.
   */
  const truncated = ref(false)

  /**
   * Номер последней запрошенной выборки: отбор переключают кликами, а ответы приходят не в том
   * порядке, в каком их спросили. Медленный ответ прошлого отбора, придя последним, положил бы
   * на экран числа одного направления под подписью другого.
   */
  let seq = 0

  /** Одиночный запрос к порталу; строки — из конверта `result`. */
  async function call<T>(method: string, params: object): Promise<T[]> {
    const result = await b24.getOrThrow().actions.v2.call.make<T[]>({ method, params })
    if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
    const rows = result.getData()?.result
    return Array.isArray(rows) ? rows as T[] : []
  }

  /** Направления сделок. Ошибка — пустой список: тогда останется хотя бы выбранное направление. */
  async function fetchCategories(): Promise<CategoryRef[]> {
    try {
      const result = await b24.getOrThrow().actions.v2.call.make<{ categories?: B24CategoryRow[] }>({
        method: 'crm.category.list',
        params: categoryListParams()
      })
      const rows = result.getData()?.result?.categories
      return Array.isArray(rows) ? adaptCategories(rows) : []
    } catch {
      return []
    }
  }

  /**
   * Перечисление разных значений поля среди сделок отбора — цепочками по 50 команд.
   *
   * ⚠ Читаем ТОЛЬКО через `readDistinctChain`: исчерпанная цепочка идёт по второму кругу без
   * единой ошибки (см. `managerQuery.ts`), и наивное чтение дало бы дубли менеджеров.
   */
  async function enumerate(
    field: string,
    base: Record<string, unknown>,
    size: number,
    maxPages: number,
    prefix: string,
    stale: () => boolean
  ): Promise<{ ids: number[], truncated: boolean }> {
    const ids: number[] = []
    for (let page = 0; page < maxPages; page++) {
      const rows = await batchRows<Record<string, unknown>>(distinctChainBatch(field, base, size, ids.at(-1) ?? 0, prefix))
      if (stale()) return { ids, truncated: false }
      const found = readDistinctChain(rows, field, size, prefix)
      ids.push(...found)
      if (found.length < size) return { ids, truncated: false }
    }
    return { ids, truncated: true }
  }

  /** Имена «моих компаний»; ошибка — не беда: офис подпишется номером, числа от этого не меняются. */
  async function fetchOfficeNames(ids: readonly number[]): Promise<Record<number, string>> {
    if (!ids.length) return {}
    try {
      const rows = await call<{ ID?: unknown, TITLE?: unknown }>('crm.company.list', companyNamesParams(ids))
      const out: Record<number, string> = {}
      for (const row of rows) {
        const id = Number(row?.ID)
        if (Number.isFinite(id) && typeof row?.TITLE === 'string' && row.TITLE.trim()) out[id] = row.TITLE
      }
      return out
    } catch {
      return {}
    }
  }

  /**
   * Забрать данные портала под отбором и пересчитать матрицу.
   *
   * Вне фрейма — тихо остаёмся на демонстрационном наборе: это штатный режим страницы, открытой
   * по прямой ссылке, а не ошибка.
   */
  async function load(next: ManagerFilters = DEFAULT_MANAGER_FILTERS): Promise<void> {
    await b24.init()
    if (!b24.isInit()) {
      const demoStages = MOCK_STAGES[next.categoryId] ?? []
      categories.value = MOCK_CATEGORIES
      stages.value = demoStages
      report.value = buildMockManagerReport(next)
      dictionaries.value = {
        sources: {},
        junkReasons: {},
        lossReasons: {},
        dealStages: stageNames(demoStages),
        users: Object.fromEntries(MOCK_MANAGERS.map(manager => [String(manager.id), manager.name]))
      }
      filters.value = next
      return
    }

    const mine = ++seq
    const stale = () => mine !== seq
    pending.value = true
    error.value = undefined
    truncated.value = false
    try {
      step.value = 'Читаем справочники портала'
      // Сотрудники читаются параллельно и никого не ждут: от их имён числа не зависят.
      const usersPromise = fetchUsers()
      const categoryList = await fetchCategories()
      if (stale()) return
      if (categoryList.length) categories.value = categoryList
      // Направление могли удалить (или его нет на этом портале) — считаем по первому из списка,
      // иначе отчёт молча показал бы нули под именем несуществующей воронки.
      const categoryId = !categoryList.length || categoryList.some(c => c.id === next.categoryId)
        ? next.categoryId
        : categoryList[0]!.id
      const applied: ManagerFilters = { ...next, categoryId }
      const base = managerDealFilter(applied)

      // Стадии направления и источники — одним пакетом: два круга по сети вместо одного стоят
      // ровно столько же, сколько лишний счётчик, но заметны на глаз при каждом переключении.
      const books = await batchRows<B24StatusRow>({
        stages: { method: 'crm.status.list', params: stageListParams(categoryId) },
        sources: dictionaryBatch().sources
      })
      if (stale()) return
      const allStages = adaptStages(books.stages ?? [])
      const scopeStages = stagesForScope(allStages, applied.scope)

      step.value = 'Ищем офисы и менеджеров'
      const officeChain = await enumerate(OFFICE_FIELD, base, OFFICE_CHAIN_SIZE, OFFICE_CHAIN_PAGES, 'o', stale)
      if (stale()) return
      const managerChain = await enumerate(MANAGER_FIELD, base, CHAIN_SIZE, MANAGER_CHAIN_PAGES, 'm', stale)
      if (stale()) return
      // «Не указана» цепочкой не находится (перечисление идёт со значений больше нуля) — это
      // отдельная строка, и на боевом портале она самая крупная.
      const officeIds = [...officeChain.ids, OFFICE_UNSET]

      step.value = `Считаем сделки: ${managerChain.ids.length} сотрудников`
      const totals: Record<string, number> = {}
      const pairsBatch = countBatch([
        ...officeCountRequests(officeIds, base),
        ...pairCountRequests(officeIds, managerChain.ids, base)
      ])
      collectTotals(await batchTotals(pairsBatch.commands), pairsBatch.keyByCommand, totals)
      if (stale()) return

      // Вопросы по стадиям — только для пар, у которых сделки есть. Пустые пары дали бы столько
      // же вопросов, сколько непустые, и на пустом направлении отчёт ждал бы минуту впустую.
      const pairs: LoadPair[] = []
      for (const officeId of officeIds) {
        for (const managerId of managerChain.ids) {
          if ((totals[pairKey(officeId, managerId)] ?? 0) > 0) pairs.push({ officeId, managerId })
        }
      }
      if (pairs.length && scopeStages.length) {
        step.value = `Считаем стадии: ${pairs.length} строк × ${scopeStages.length}`
        const cellsBatch = countBatch(cellCountRequests(pairs, scopeStages.map(stage => stage.id), base))
        collectTotals(await batchTotals(cellsBatch.commands), cellsBatch.keyByCommand, totals)
        if (stale()) return
      }

      step.value = 'Читаем названия'
      const officeNames = await fetchOfficeNames(officeChain.ids)
      const users = await usersPromise
      if (stale()) return

      const offices: OfficeRef[] = officeIds.map(id => ({
        id,
        name: id === OFFICE_UNSET ? OFFICE_UNSET_LABEL : (officeNames[id] ?? `Компания #${id}`)
      }))
      const managers: ManagerRef[] = managerChain.ids.map(id => ({ id, name: users[String(id)] ?? `Сотрудник #${id}` }))

      report.value = buildManagerLoad({ offices, managers, stages: scopeStages, totals })
      stages.value = allStages
      dictionaries.value = {
        sources: statusNames(books.sources ?? []),
        junkReasons: {},
        lossReasons: {},
        dealStages: stageNames(allStages),
        users
      }
      filters.value = applied
      truncated.value = managerChain.truncated || officeChain.truncated
      source.value = 'portal'
    } catch (e) {
      if (!stale()) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      // ⚠ Гасим индикатор только за СВОЙ запрос: иначе устаревший ответ снял бы «считаем» с ещё
      // идущей выборки, и экран замер бы со старыми числами без единого признака работы.
      if (!stale()) {
        pending.value = false
        step.value = undefined
      }
    }
  }

  return { report, categories, stages, dictionaries, filters, pending, step, error, truncated, isDemo, source, load }
}
