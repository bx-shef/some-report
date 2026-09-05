import { share } from '~/utils/metrics'
import type {
  DealScope,
  ManagerLoadCompany,
  ManagerLoadReport,
  ManagerLoadRow,
  ManagerRef,
  CompanyRef,
  StageRef
} from '~/types/managers'

/**
 * Ядро отчёта «Сделки по менеджерам»: из счётчиков портала — матрица «моя компания» → менеджер
 * → стадия.
 *
 * Здесь только чистые функции: ни сети, ни SDK, ни `Date.now()`. Портал отвечает на сотни
 * вопросов «сколько», а этот модуль решает, что из них показать, в каком порядке и что делать с
 * тем, что не сошлось. Ровно эта арифметика и ломается молча — поэтому она под тестом.
 *
 * ⚠ Счётчики приходят РАЗНЫМИ пакетами, между ними проходят секунды, и портал в это время живёт:
 * сделку могли создать, закрыть или передать другому. Поэтому итог компании берётся отдельным
 * счётчиком, а не суммой строк, и всё, что не сошлось, показывается остатком (`unlisted`,
 * `otherStages`), а не прячется. Отрицательных остатков не бывает: они подрезаются нулём.
 */

/** «Моя компания» у сделки не заполнена. В фильтре REST это значение и означает «пусто». */
export const COMPANY_UNSET = 0

/**
 * Как подписана группа сделок с незаполненной «моей компанией» ТАМ, ГДЕ РЯДОМ ЕСТЬ КОНТЕКСТ, —
 * в карточке таблицы и в легенде диаграммы, над которыми стоит заголовок про «мою компанию».
 *
 * ⚠ Не «Другие» и не «Прочее»: это незаполненное поле, и подпись должна читаться именно так.
 * Формулировку выбрал владелец 2026-09-05.
 */
export const COMPANY_UNSET_LABEL = 'Не указана'

/**
 * Та же группа там, где контекста рядом НЕТ: пункт фильтра и заголовок списка по клику.
 *
 * ⚠ Две подписи вместо одной — не забытая унификация. «Не указана» в выпадающем списке рядом с
 * названиями компаний непонятна («что не указана?»), а «Без моей компании» заголовком каждой
 * карточки повторяло бы название поля из панели в каждой строке экрана.
 */
export const COMPANY_UNSET_FULL_LABEL = 'Без моей компании'

/** Как назвать группу там, где рядом нет заголовка про «мою компанию». */
export function companyFullLabel(companyId: number, companyName: string): string {
  return companyId === COMPANY_UNSET ? COMPANY_UNSET_FULL_LABEL : companyName
}

/** Как подписан остаток «сделки компании вне строк таблицы». */
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

export function companyKey(companyId: number): string {
  return `mc|${companyId}`
}

export function pairKey(companyId: number, managerId: number): string {
  return `p|${companyId}|${managerId}`
}

/**
 * Счётчик «моя компания + стадия» — итог колонки.
 *
 * ⚠ Отдельный вопрос порталу, а НЕ сумма клеток над ним. Сумма не включала бы сделки, у которых
 * ответственного нет вовсе (строка «вне таблицы»), — и клик по итогу колонки открывал бы список
 * длиннее числа, по которому нажали. Ровно то, чего этот отчёт не должен делать.
 */
export function companyStageKey(companyId: number, stageId: string): string {
  return `mcs|${companyId}|${stageId}`
}

export function cellKey(companyId: number, managerId: number, stageId: string): string {
  return `c|${companyId}|${managerId}|${stageId}`
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
  /** «Мои компании», встреченные у сделок отбора. `COMPANY_UNSET` — сделки с незаполненным полем. */
  companies: readonly CompanyRef[]
  /** Менеджеры, встреченные у сделок отбора. */
  managers: readonly ManagerRef[]
  /** Колонки: стадии охвата из справочника направления. */
  stages: readonly StageRef[]
  /** Счётчики портала по ключам `totalKey` / `companyKey` / `pairKey` / `cellKey`. */
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
  const companies: ManagerLoadCompany[] = []
  const byStage: Record<string, number> = {}
  const managerIds = new Set<number>()

  for (const company of input.companies) {
    const rows: ManagerLoadRow[] = []
    for (const manager of input.managers) {
      const total = count(totals, pairKey(company.id, manager.id))
      if (total === 0) continue
      const rowStages: Record<string, number> = {}
      for (const stage of input.stages) {
        const value = count(totals, cellKey(company.id, manager.id, stage.id))
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
    // Итог компании — свой счётчик: сумма строк его не заменяет, потому что сделки уволенных и
    // неназначенные в строки не попадают, а в компании они есть. Разница и есть `unlisted`.
    const rowsTotal = sum(rows.map(row => row.total))
    const companyTotal = Math.max(count(totals, companyKey(company.id)), rowsTotal)
    if (companyTotal === 0) continue
    rows.sort((a, b) => b.total - a.total || a.managerName.localeCompare(b.managerName, 'ru') || a.managerId - b.managerId)
    // Делим только через `share()` — общее правило проекта: пустой отбор здесь норма, а `x / 0`
    // в шаблоне печатает «NaN %», после чего отчёт перестают читать целиком.
    for (const row of rows) row.share = share(row.total, companyTotal)
    // Итог колонки — свой счётчик портала; сумма клеток над ним берётся только если счётчика
    // нет. Разница между ними — сделки строки «вне таблицы»: их стадии известны, а ответственный
    // нет, поэтому раскладываются они здесь, а не в строке менеджера.
    const companyStages: Record<string, number> = {}
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
      const counted = count(totals, companyStageKey(company.id, stage.id))
      if (counted > 0) stageCounters = true
      const value = Math.max(counted, listed)
      if (value === 0) continue
      companyStages[stage.id] = value
      byStage[stage.id] = (byStage[stage.id] ?? 0) + value
      if (value > listed) unlistedByStage[stage.id] = value - listed
    }
    const unlisted = Math.max(0, companyTotal - rowsTotal)
    companies.push({
      companyId: company.id,
      companyName: company.name,
      rows,
      byStage: companyStages,
      // Сделки компании вне колонок: стадии, которой нет в справочнике направления.
      otherStages: !input.stages.length
        ? 0
        : stageCounters
          ? Math.max(0, companyTotal - sum(Object.values(companyStages)))
          : sum(rows.map(row => row.otherStages)),
      total: companyTotal,
      unlisted,
      unlistedByStage: unlisted > 0 ? unlistedByStage : {},
      share: 0
    })
  }

  const companiesTotal = sum(companies.map(company => company.total))
  const total = Math.max(count(totals, totalKey()), companiesTotal)
  // Под отбором нет ни одной сделки — показывать нечего, и «скрыто 4 пустых стадии» здесь было
  // бы шумом: экран в этом случае говорит «сделок нет», а не рисует таблицу из заголовков.
  if (total === 0) return emptyManagerLoad()
  for (const company of companies) company.share = share(company.total, total)
  // ⚠ «Не указана» идёт в общем порядке — по числу сделок, как все остальные. Раньше она стояла
  // последней как «незаполненное поле»; решение владельца от 2026-09-05: это такая же группа, а
  // выбор «смотреть её или нет» отдан фильтру «Моя компания» в панели. Отдельное место в
  // сортировке означало бы, что отчёт спорит с фильтром, который человек только что выставил.
  companies.sort((a, b) =>
    b.total - a.total || a.companyName.localeCompare(b.companyName, 'ru') || a.companyId - b.companyId
  )

  // Пустые колонки убираем: у направления заказчика 16 стадий, из них «в работе» четыре, и
  // двенадцать пустых столбцов сделали бы таблицу нечитаемой. Сколько скрыто — говорим подписью.
  const stages = input.stages.filter(stage => (byStage[stage.id] ?? 0) > 0)

  return {
    companies,
    stages,
    hiddenStages: input.stages.length - stages.length,
    byStage,
    otherStages: sum(companies.map(company => company.otherStages)),
    // Сделки вне строк: не разложенные по менеджерам внутри компаний плюс не попавшие ни в один
    // компания (компания не перечислился) — одним числом, потому что показываются одной подписью.
    unlisted: sum(companies.map(company => company.unlisted)) + Math.max(0, total - companiesTotal),
    total,
    managers: managerIds.size,
    companyCount: companies.length
  }
}

/** Пустой отчёт — до первой выборки и когда под отбором нет ни одной сделки. */
export function emptyManagerLoad(): ManagerLoadReport {
  return {
    companies: [],
    stages: [],
    hiddenStages: 0,
    byStage: {},
    otherStages: 0,
    unlisted: 0,
    total: 0,
    managers: 0,
    companyCount: 0
  }
}
