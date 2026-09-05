import type { ManagerCellRef, ManagerLoadCompany, ManagerLoadReport } from '~/types/managers'
import { cellKey, pairKey } from '~/utils/managerLoad'
import type { SunburstNode } from '~/utils/sunburst'

/**
 * Дерево для диаграммы «Распределение»: менеджер → стадия внутри ОДНОЙ «моей компании».
 *
 * ⚠ Компании в кольцах НЕТ, и это решение владельца от 2026-09-05. Она выбирается фильтром, по
 * одной за раз: разделив круг между компаниями, мы отдавали одной из них почти весь круг (на
 * боевом портале в сентябре это 599 сделок против одной), и всё интересное — менеджеры и стадии —
 * сжималось в неразличимую штриховку по краю.
 *
 * Функция чистая и потому под тестом: диаграмма — это те же числа, что в таблице, и разойтись с
 * ней она не имеет права. Ровно этим и опасны диаграммы, собранные в шаблоне компонента: число
 * под кольцом и число в таблице считаются разными способами, а замечают это на боевых данных.
 *
 * ⚠ Ключи узлов — ТЕ ЖЕ, что у счётчиков ядра (`pairKey`/`cellKey`). Не ради экономии, а чтобы
 * клик по сектору открывал список ровно тем условием, которое дало число: рядом возвращается
 * карта «ключ → клетка матрицы», и придумывать своё соответствие (и ошибиться в нём) негде.
 */
export interface ManagerChart {
  nodes: SunburstNode[]
  /** Что открыть по клику: ключ сектора → та же клетка, что и число в таблице. */
  refs: Record<string, ManagerCellRef>
}

/**
 * Сколько менеджеров показывать в кольце.
 *
 * ⚠ Не всех. На боевом портале в направлении 30 ответственных с открытыми сделками, и у половины
 * их единицы: их сектора превращают кольцо в штриховку, где не читается ни один. Хвост
 * сворачивается в один сектор «Остальные», и он НЕ кликабелен — списка «остальные менеджеры»
 * фильтром REST не выразить, а число без совпадающего с ним списка в этом отчёте некликабельно.
 */
export const CHART_MANAGERS = 12

/** Подпись свёрнутого хвоста менеджеров. */
export const CHART_REST_LABEL = 'Остальные'

/** Подпись сектора сделок компании без ответственного. */
export const CHART_UNLISTED_LABEL = 'Без ответственного'

/**
 * «Авдеева Мария» → «Авдеева М.»: подпись для сектора кольца.
 *
 * ⚠ Сокращаем ФАМИЛИЮ + инициал, а не режем строку по длине: «Авдеева …» и «Авдеенко …» на
 * соседних секторах выглядели бы одинаково, а это разные люди. Полное имя остаётся в подсказке,
 * в легенде и в таблице.
 */
export function shortManagerName(name: string): string {
  const [surname, first] = name.trim().split(/\s+/)
  if (!surname) return name
  return first ? `${surname} ${first.slice(0, 1)}.` : surname
}

export function managerChart(report: ManagerLoadReport, company: ManagerLoadCompany | undefined): ManagerChart {
  const nodes: SunburstNode[] = []
  const refs: Record<string, ManagerCellRef> = {}
  if (!company) return { nodes, refs }
  const stageName = new Map(report.stages.map(stage => [stage.id, stage.name]))

  const shown = company.rows.slice(0, CHART_MANAGERS)
  for (const row of shown) {
    const managerNode: SunburstNode = {
      key: pairKey(company.companyId, row.managerId),
      label: row.managerName,
      short: shortManagerName(row.managerName),
      value: row.total,
      children: []
    }
    refs[managerNode.key] = {
      companyId: company.companyId,
      managerId: row.managerId,
      title: `Сделки: ${company.companyName} · ${row.managerName}`,
      total: row.total
    }
    // Стадии — только те, что есть в таблице: колонки и кольцо обязаны показывать одно и то же.
    for (const stage of report.stages) {
      const value = row.byStage[stage.id] ?? 0
      if (value <= 0) continue
      const key = cellKey(company.companyId, row.managerId, stage.id)
      managerNode.children!.push({ key, label: stage.name, value })
      refs[key] = {
        companyId: company.companyId,
        managerId: row.managerId,
        stageId: stage.id,
        title: `Сделки: ${company.companyName} · ${row.managerName} · ${stageName.get(stage.id) ?? stage.id}`,
        total: value
      }
    }
    nodes.push(managerNode)
  }

  // Хвост менеджеров и сделки без ответственного — своими секторами: место в кольце они
  // занимают (иначе сумма секторов разошлась бы с числом в центре), но списка за собой не имеют,
  // поэтому и ключа в `refs` у них нет.
  const rest = company.rows.slice(CHART_MANAGERS).reduce((sum, row) => sum + row.total, 0)
  if (rest > 0) {
    nodes.push({ key: `${pairKey(company.companyId, 0)}|rest`, label: CHART_REST_LABEL, value: rest })
  }
  if (company.unlisted > 0) {
    nodes.push({ key: `${pairKey(company.companyId, 0)}|unlisted`, label: CHART_UNLISTED_LABEL, value: company.unlisted })
  }
  return { nodes, refs }
}
