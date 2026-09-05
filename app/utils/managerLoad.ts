import type {
  DealScope,
  ManagerLoadOffice,
  ManagerLoadReport,
  ManagerLoadRow,
  ManagerRef,
  OfficeRef,
  StageRef
} from '~/types/managers'

/**
 * Ядро отчёта «Сделки по менеджерам»: из счётчиков портала — матрица офис → менеджер → стадия.
 *
 * Здесь только чистые функции: ни сети, ни SDK, ни `Date.now()`. Портал отвечает на сотни
 * вопросов «сколько», а этот модуль решает, что из них показать, в каком порядке и что делать с
 * тем, что не сошлось. Ровно эта арифметика и ломается молча — поэтому она под тестом.
 *
 * ⚠ Счётчики приходят РАЗНЫМИ пакетами, между ними проходят секунды, и портал в это время живёт:
 * сделку могли создать, закрыть или передать другому. Поэтому итог офиса берётся отдельным
 * счётчиком, а не суммой строк, и всё, что не сошлось, показывается остатком (`unlisted`,
 * `otherStages`), а не прячется. Отрицательных остатков не бывает: они подрезаются нулём.
 */

/** «Моя компания» у сделки не заполнена. В фильтре REST это значение и означает «пусто». */
export const OFFICE_UNSET = 0

/** Как подписан офис без «моей компании». Не «Другие»: это не офис, а незаполненное поле. */
export const OFFICE_UNSET_LABEL = 'Моя компания не указана'

/** Как подписан остаток «сделки офиса вне строк таблицы». */
export const UNLISTED_MANAGER_LABEL = 'Ответственный не указан или не найден'

/** Подписи охвата — одни и те же в панели, в заголовке слайдера и в подписи под таблицей. */
export const SCOPE_LABELS: Record<DealScope, string> = {
  'in-work': 'В работе',
  'won': 'Успешные',
  'lost': 'Провальные',
  'all': 'Все стадии'
}

/**
 * Семантика стадии для охвата — то, что уходит в фильтр `STAGE_SEMANTIC_ID`.
 *
 * ⚠ Семантику берём у портала, а не выводим из кода стадии: у заказчика провальных стадий в
 * одном направлении одиннадцать, и зашитый список кодов посчитал бы чужую воронку (`CLAUDE.md`).
 */
export function scopeSemantic(scope: DealScope): 'P' | 'S' | 'F' | undefined {
  switch (scope) {
    case 'in-work': return 'P'
    case 'won': return 'S'
    case 'lost': return 'F'
    case 'all': return undefined
  }
}

/** Стадии направления, попадающие в охват: колонки таблицы и вопросы «сколько» к порталу. */
export function stagesForScope(stages: readonly StageRef[], scope: DealScope): StageRef[] {
  const semantic = scopeSemantic(scope)
  return semantic === undefined ? [...stages] : stages.filter(stage => stage.semantic === semantic)
}

/**
 * Ключи счётчиков. Их строит и читает один модуль — ядро; запросы (`managerQuery.ts`) берут их
 * отсюда же, поэтому разъехаться карте вопросов и карте ответов негде.
 *
 * ⚠ Разделитель `|`, а не `:`: коды стадий у направлений вида `C4:LOSE` уже содержат двоеточие,
 * и ключ `c|4|17|C4:LOSE` разбирается однозначно, а `c:4:17:C4:LOSE` — нет.
 */
export function totalKey(): string {
  return 't'
}

export function officeKey(officeId: number): string {
  return `o|${officeId}`
}

export function pairKey(officeId: number, managerId: number): string {
  return `p|${officeId}|${managerId}`
}

/**
 * Счётчик «офис + стадия» — итог колонки.
 *
 * ⚠ Отдельный вопрос порталу, а НЕ сумма клеток над ним. Сумма не включала бы сделки, у которых
 * ответственного нет вовсе (строка «вне таблицы»), — и клик по итогу колонки открывал бы список
 * длиннее числа, по которому нажали. Ровно то, чего этот отчёт не должен делать.
 */
export function officeStageKey(officeId: number, stageId: string): string {
  return `os|${officeId}|${stageId}`
}

export function cellKey(officeId: number, managerId: number, stageId: string): string {
  return `c|${officeId}|${managerId}|${stageId}`
}

/**
 * Сколько примерно ждать счётчики стадий, секунды.
 *
 * Пакет из 50 вопросов «сколько» портал считает от 0,26 с (открытые сделки) до 3,5 с (все сделки
 * направления, 600 тысяч записей) — замер `docs/PORTAL.md`. Берём два: обещать лучшее время
 * значит обещать то, чего человек не увидит на охвате «все стадии».
 */
export const SECONDS_PER_COUNT_BATCH = 2

export function stageCountSeconds(cells: number, batchSize = 50): number {
  return Math.ceil(cells / batchSize) * SECONDS_PER_COUNT_BATCH
}

/** Что нужно ядру, чтобы собрать матрицу. */
export interface ManagerLoadInput {
  /** Офисы, встреченные у сделок отбора. `OFFICE_UNSET` — сделки с незаполненным полем. */
  offices: readonly OfficeRef[]
  /** Менеджеры, встреченные у сделок отбора. */
  managers: readonly ManagerRef[]
  /** Колонки: стадии охвата из справочника направления. */
  stages: readonly StageRef[]
  /** Счётчики портала по ключам `totalKey` / `officeKey` / `pairKey` / `cellKey`. */
  totals: Record<string, number>
}

function count(totals: Record<string, number>, key: string): number {
  const value = totals[key]
  return Number.isFinite(value) && value! > 0 ? Math.trunc(value!) : 0
}

function sum(values: Iterable<number>): number {
  let out = 0
  for (const value of values) out += value
  return out
}

/**
 * Матрица из счётчиков.
 *
 * Порядок строк — по числу сделок вниз: отчёт открывают, чтобы увидеть, у кого их больше всего.
 * При равенстве — по имени, иначе строки прыгали бы между обновлениями при одинаковых числах.
 */
export function buildManagerLoad(input: ManagerLoadInput): ManagerLoadReport {
  const { totals } = input
  const offices: ManagerLoadOffice[] = []
  const byStage: Record<string, number> = {}
  const managerIds = new Set<number>()

  for (const office of input.offices) {
    const rows: ManagerLoadRow[] = []
    for (const manager of input.managers) {
      const total = count(totals, pairKey(office.id, manager.id))
      if (total === 0) continue
      const rowStages: Record<string, number> = {}
      for (const stage of input.stages) {
        const value = count(totals, cellKey(office.id, manager.id, stage.id))
        if (value > 0) rowStages[stage.id] = value
      }
      rows.push({
        managerId: manager.id,
        managerName: manager.name,
        byStage: rowStages,
        // Колонок не просили (стадии считаются по кнопке) — «прочих стадий» тоже нет: иначе
        // остатком оказались бы ВСЕ сделки строки, и экран сказал бы неправду.
        otherStages: input.stages.length ? Math.max(0, total - sum(Object.values(rowStages))) : 0,
        total,
        share: 0
      })
      managerIds.add(manager.id)
    }
    // Итог офиса — свой счётчик: сумма строк его не заменяет, потому что сделки уволенных и
    // неназначенные в строки не попадают, а в офисе они есть. Разница и есть `unlisted`.
    const rowsTotal = sum(rows.map(row => row.total))
    const officeTotal = Math.max(count(totals, officeKey(office.id)), rowsTotal)
    if (officeTotal === 0) continue
    rows.sort((a, b) => b.total - a.total || a.managerName.localeCompare(b.managerName, 'ru') || a.managerId - b.managerId)
    for (const row of rows) row.share = officeTotal > 0 ? row.total / officeTotal : 0
    // Итог колонки — свой счётчик портала; сумма клеток над ним берётся только если счётчика
    // нет. Разница между ними — сделки строки «вне таблицы»: их стадии известны, а ответственный
    // нет, поэтому раскладываются они здесь, а не в строке менеджера.
    const officeStages: Record<string, number> = {}
    const listedByStage: Record<string, number> = {}
    for (const row of rows) {
      for (const [stageId, value] of Object.entries(row.byStage)) {
        listedByStage[stageId] = (listedByStage[stageId] ?? 0) + value
      }
    }
    const unlistedByStage: Record<string, number> = {}
    // Пришли ли счётчики колонок. Без них итог колонки — сумма клеток, и тогда сделки строки
    // «вне таблицы» по стадиям не разложены: записать их в «прочие стадии» значило бы объявить
    // их стоящими на неизвестной стадии, а это разные вещи.
    let stageCounters = false
    for (const stage of input.stages) {
      const listed = listedByStage[stage.id] ?? 0
      const counted = count(totals, officeStageKey(office.id, stage.id))
      if (counted > 0) stageCounters = true
      const value = Math.max(counted, listed)
      if (value === 0) continue
      officeStages[stage.id] = value
      byStage[stage.id] = (byStage[stage.id] ?? 0) + value
      if (value > listed) unlistedByStage[stage.id] = value - listed
    }
    const unlisted = Math.max(0, officeTotal - rowsTotal)
    offices.push({
      officeId: office.id,
      officeName: office.name,
      rows,
      byStage: officeStages,
      // Сделки офиса вне колонок: стадии, которой нет в справочнике направления.
      otherStages: !input.stages.length
        ? 0
        : stageCounters
          ? Math.max(0, officeTotal - sum(Object.values(officeStages)))
          : sum(rows.map(row => row.otherStages)),
      total: officeTotal,
      unlisted,
      unlistedByStage: unlisted > 0 ? unlistedByStage : {},
      share: 0
    })
  }

  const officesTotal = sum(offices.map(office => office.total))
  const total = Math.max(count(totals, totalKey()), officesTotal)
  // Под отбором нет ни одной сделки — показывать нечего, и «скрыто 4 пустых стадии» здесь было
  // бы шумом: экран в этом случае говорит «сделок нет», а не рисует таблицу из заголовков.
  if (total === 0) return emptyManagerLoad()
  for (const office of offices) office.share = total > 0 ? office.total / total : 0
  // «Не указана» — не офис, а незаполненное поле, поэтому она всегда последняя, даже когда
  // сделок в ней больше всех (на боевом портале так и есть). Иначе таблица начиналась бы с
  // строки о качестве данных, а не с офиса, ради которого её открыли.
  offices.sort((a, b) => {
    if ((a.officeId === OFFICE_UNSET) !== (b.officeId === OFFICE_UNSET)) return a.officeId === OFFICE_UNSET ? 1 : -1
    return b.total - a.total || a.officeName.localeCompare(b.officeName, 'ru') || a.officeId - b.officeId
  })

  // Пустые колонки убираем: у направления заказчика 16 стадий, из них «в работе» четыре, и
  // двенадцать пустых столбцов сделали бы таблицу нечитаемой. Сколько скрыто — говорим подписью.
  const stages = input.stages.filter(stage => (byStage[stage.id] ?? 0) > 0)

  return {
    offices,
    stages,
    hiddenStages: input.stages.length - stages.length,
    byStage,
    otherStages: sum(offices.map(office => office.otherStages)),
    // Сделки вне строк: не разложенные по менеджерам внутри офисов плюс не попавшие ни в один
    // офис (офис не перечислился) — одним числом, потому что показываются одной подписью.
    unlisted: sum(offices.map(office => office.unlisted)) + Math.max(0, total - officesTotal),
    total,
    managers: managerIds.size,
    officeCount: offices.length
  }
}

/** Пустой отчёт — до первой выборки и когда под отбором нет ни одной сделки. */
export function emptyManagerLoad(): ManagerLoadReport {
  return {
    offices: [],
    stages: [],
    hiddenStages: 0,
    byStage: {},
    otherStages: 0,
    unlisted: 0,
    total: 0,
    managers: 0,
    officeCount: 0
  }
}
