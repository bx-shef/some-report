import type { CategoryRef, ManagerFilters, ManagerLoadReport, ManagerRef, OfficeRef, StageRef } from '~/types/managers'
import type { ReportDictionaries } from '~/types/report'
import { statusNames, type B24StatusRow } from '~/utils/b24Adapter'
import { categoryListParams, dictionaryBatch } from '~/utils/b24Query'
import { adaptCategories, adaptStages, stageNames, type B24CategoryRow } from '~/utils/managerAdapter'
import {
  buildManagerLoad,
  emptyManagerLoad,
  OFFICE_UNSET,
  OFFICE_UNSET_LABEL,
  pairKey,
  stageCountSeconds,
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
  officeStageCountRequests,
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
 * Порядок выборки (замер по боевому порталу 2026-09-05, ≈ 16 с на направление):
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

/**
 * Сколько вопросов «сколько» по клеткам матрицы отчёт задаёт САМ, не спрашивая человека.
 *
 * ⚠ Клетки — это «пары × стадии», и число их растёт произведением. На боевом портале в охвате
 * «в работе» их 384 (8 пакетов, 5 секунд), а в охвате «все стадии» на том же направлении было бы
 * около трёх тысяч — минуты ожидания под обещание «пятнадцать секунд». Поэтому выше порога
 * стадии считаются ПО КНОПКЕ, а до неё на экране матрица с итогами: это честнее, чем молча
 * заставить ждать (тот же приём, что у фоновых выборок отчёта по лидам).
 */
export const CELL_AUTO_MAX = 800

/** Умолчание отбора: направление по умолчанию портала, сделки в работе, за всё время. */
export const DEFAULT_MANAGER_FILTERS: ManagerFilters = { categoryId: 0, scope: 'in-work' }

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
   * Перечисление упёрлось в предел. Признака ДВА, а не один: у офисов и у менеджеров разные
   * пределы и разные подсказки человеку, и общий флаг назвал бы причину неверно.
   */
  const truncatedManagers = ref(false)
  const truncatedOffices = ref(false)
  /**
   * Стадии ждут кнопки: клеток слишком много (см. `CELL_AUTO_MAX`). Пока так — в таблице только
   * итоги, а экран говорит, сколько ждать.
   */
  const stagesDeferred = ref(false)
  /** Сколько примерно секунд займут счётчики стадий — по числу клеток. */
  const stagesEstimateSeconds = ref(0)

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

  /** Что нужно, чтобы досчитать стадии по кнопке, не повторяя всю выборку заново. */
  let deferred: {
    offices: OfficeRef[]
    managers: ManagerRef[]
    stages: StageRef[]
    pairs: LoadPair[]
    base: Record<string, unknown>
    totals: Record<string, number>
    mine: number
  } | undefined

  /** Счётчики клеток «пара + стадия» — пакетами по 50; результат кладётся в тот же набор. */
  async function countStages(
    pairs: readonly LoadPair[],
    stageList: readonly StageRef[],
    base: Record<string, unknown>,
    totals: Record<string, number>,
    mine: number
  ): Promise<void> {
    const batch = countBatch(cellCountRequests(pairs, stageList.map(stage => stage.id), base))
    const answers = await batchTotals(batch.commands)
    if (mine !== seq) return
    collectTotals(answers, batch.keyByCommand, totals)
  }

  /**
   * Досчитать стадии по кнопке — когда клеток слишком много для автоматического прохода.
   *
   * ⚠ Пересобираем матрицу из ТЕХ ЖЕ счётчиков пар, что уже пришли: заново их не спрашиваем.
   * Второе нажатие, пока идёт первое, ничего не делает — иначе портал получил бы те же сотни
   * вопросов дважды.
   */
  async function startStages(): Promise<void> {
    if (!deferred || pending.value) return
    const context = deferred
    if (context.mine !== seq) return
    pending.value = true
    error.value = undefined
    step.value = `Считаем стадии: ${context.pairs.length} строк × ${context.stages.length}`
    try {
      await countStages(context.pairs, context.stages, context.base, context.totals, context.mine)
      if (context.mine !== seq) return
      report.value = buildManagerLoad({
        offices: context.offices,
        managers: context.managers,
        stages: context.stages,
        totals: context.totals
      })
      stagesDeferred.value = false
      deferred = undefined
    } catch (e) {
      if (context.mine === seq) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (context.mine === seq) {
        pending.value = false
        step.value = undefined
      }
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
    truncatedManagers.value = false
    truncatedOffices.value = false
    stagesDeferred.value = false
    deferred = undefined
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
      // Итоги офисов, итоги колонок и пары «офис + менеджер» — одним заходом. Итоги колонок
      // спрашиваются отдельно, а не суммируются из клеток: в сумму не попали бы сделки без
      // ответственного, и клик по итогу колонки открывал бы список длиннее числа над ним.
      const pairsBatch = countBatch([
        ...officeCountRequests(officeIds, base),
        ...officeStageCountRequests(officeIds, scopeStages.map(stage => stage.id), base),
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
      const cells = pairs.length * scopeStages.length
      stagesEstimateSeconds.value = stageCountSeconds(cells)
      // Клеток слишком много — стадии по кнопке. Молча заставлять ждать минуты под обещание
      // «пятнадцать секунд» нельзя: человек решит, что отчёт завис, и перезагрузит страницу.
      const countCells = cells > 0 && cells <= CELL_AUTO_MAX
      if (countCells) {
        step.value = `Считаем стадии: ${pairs.length} строк × ${scopeStages.length}`
        await countStages(pairs, scopeStages, base, totals, mine)
        if (stale()) return
      } else if (cells > 0) {
        stagesDeferred.value = true
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

      // Отложенные стадии — таблица БЕЗ колонок, а не с пустыми: иначе каждая строка показала бы
      // все свои сделки как «прочие стадии», то есть неправду.
      report.value = buildManagerLoad({ offices, managers, stages: stagesDeferred.value ? [] : scopeStages, totals })
      if (stagesDeferred.value) deferred = { offices, managers, stages: scopeStages, pairs, base, totals, mine }
      stages.value = allStages
      dictionaries.value = {
        sources: statusNames(books.sources ?? []),
        junkReasons: {},
        lossReasons: {},
        dealStages: stageNames(allStages),
        users
      }
      filters.value = applied
      truncatedManagers.value = managerChain.truncated
      truncatedOffices.value = officeChain.truncated
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

  return {
    report,
    categories,
    stages,
    dictionaries,
    filters,
    pending,
    step,
    error,
    truncatedManagers,
    truncatedOffices,
    stagesDeferred,
    stagesEstimateSeconds,
    startStages,
    isDemo,
    source,
    load
  }
}
