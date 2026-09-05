import type { ManagerCellRef, ManagerLoadReport } from '~/types/managers'
import { cellKey, companyFullLabel, companyKey, pairKey } from '~/utils/managerLoad'
import type { SunburstNode } from '~/utils/sunburst'

/**
 * Дерево для диаграммы «Распределение»: «моя компания» → менеджер → стадия.
 *
 * Функция чистая и потому под тестом: диаграмма — это те же числа, что в таблице, и разойтись с
 * ней она не имеет права. Ровно этим и опасны диаграммы, собранные в шаблоне компонента: число
 * под кольцом и число в таблице считаются разными способами, а замечают это на боевых данных.
 *
 * ⚠ Ключи узлов — ТЕ ЖЕ, что у счётчиков ядра (`companyKey`/`pairKey`/`cellKey`). Не ради
 * экономии, а чтобы клик по сектору открывал список ровно тем условием, которое дало число:
 * рядом со списком возвращается карта «ключ → клетка матрицы», и придумывать своё соответствие
 * (и ошибиться в нём) негде.
 */
export interface ManagerChart {
  nodes: SunburstNode[]
  /** Что открыть по клику: ключ сектора → та же клетка, что и число в таблице. */
  refs: Record<string, ManagerCellRef>
}

/**
 * Сколько менеджеров показывать в кольце у одной компании.
 *
 * ⚠ Не «всех». На боевом портале в направлении 70 ответственных: 70 секторов по пять градусов
 * превращают кольцо в штриховку, где не читается ни один. Хвост сворачивается в один сектор
 * «Остальные», и он НЕ кликабелен — списка «остальные менеджеры» фильтром REST не выразить, а
 * число без совпадающего с ним списка в этом отчёте некликабельно (`CLAUDE.md`).
 */
export const CHART_MANAGERS_PER_COMPANY = 8

/** Подпись свёрнутого хвоста менеджеров. */
export const CHART_REST_LABEL = 'Остальные'

export function managerChart(report: ManagerLoadReport): ManagerChart {
  const nodes: SunburstNode[] = []
  const refs: Record<string, ManagerCellRef> = {}
  const stageName = new Map(report.stages.map(stage => [stage.id, stage.name]))

  for (const company of report.companies) {
    const companyLabel = companyFullLabel(company.companyId, company.companyName)
    const companyNode: SunburstNode = {
      key: companyKey(company.companyId),
      label: companyLabel,
      value: company.total,
      children: []
    }
    refs[companyNode.key] = {
      companyId: company.companyId,
      title: `Сделки: ${companyLabel}`,
      total: company.total
    }

    const shown = company.rows.slice(0, CHART_MANAGERS_PER_COMPANY)
    for (const row of shown) {
      const managerNode: SunburstNode = {
        key: pairKey(company.companyId, row.managerId),
        label: `${companyLabel} · ${row.managerName}`,
        value: row.total,
        children: []
      }
      refs[managerNode.key] = {
        companyId: company.companyId,
        managerId: row.managerId,
        title: `Сделки: ${companyLabel} · ${row.managerName}`,
        total: row.total
      }
      // Стадии — только те, что есть в таблице: колонки и кольцо обязаны показывать одно и то же.
      for (const stage of report.stages) {
        const value = row.byStage[stage.id] ?? 0
        if (value <= 0) continue
        const key = cellKey(company.companyId, row.managerId, stage.id)
        managerNode.children!.push({ key, label: `${row.managerName} · ${stage.name}`, value })
        refs[key] = {
          companyId: company.companyId,
          managerId: row.managerId,
          stageId: stage.id,
          title: `Сделки: ${companyLabel} · ${row.managerName} · ${stageName.get(stage.id) ?? stage.id}`,
          total: value
        }
      }
      companyNode.children!.push(managerNode)
    }

    // Хвост менеджеров и сделки без строки — одним сектором «Остальные»: место в кольце они
    // занимают, но списка за собой не имеют, поэтому и ключа в `refs` у них нет.
    const rest = company.rows.slice(CHART_MANAGERS_PER_COMPANY).reduce((sum, row) => sum + row.total, 0) + company.unlisted
    if (rest > 0) {
      companyNode.children!.push({
        key: `${companyKey(company.companyId)}|rest`,
        label: `${companyLabel} · ${CHART_REST_LABEL}`,
        value: rest
      })
    }
    nodes.push(companyNode)
  }
  return { nodes, refs }
}
