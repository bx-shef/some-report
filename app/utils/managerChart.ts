import type { ManagerCellRef, ManagerLoadCompany, ManagerLoadReport } from '~/types/managers'
import { cellKey, companyFullLabel, pairKey } from '~/utils/managerLoad'
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
  /**
   * Что открыть по клику: ключ → та же клетка, что и число в таблице.
   *
   * ⚠ Здесь ВСЕ менеджеры компании, а не только нарисованные в кольце. Кольцо показывает первые
   * `CHART_MANAGERS`, а легенда рядом — всех, и её числа обязаны открывать список так же, как
   * числа таблицы. Ключи те же (`pairKey`), поэтому одно и то же число открывает один и тот же
   * список, откуда по нему ни нажали.
   */
  refs: Record<string, ManagerCellRef>
}

/**
 * Порядок цветов палитры по кругу — подобран перебором, а не выбран на глаз.
 *
 * ⚠ Двенадцати попарно различимых при дальтонизме цветов не существует, поэтому подбирались
 * СОСЕДИ: у этого порядка худшая соседняя пара — ΔE 37.1 при пороге 8, с учётом протанопии,
 * дейтеранопии и тританопии в обеих темах. Порядок «просто по возрастанию» даёт 7.1, то есть
 * не проходит. Менять нельзя, не перепроверив: сторожит `tests/palette.test.ts`.
 *
 * ⚠ Второе условие подбора — насыщенные цвета РАНЬШЕ. У отдела из трёх человек видно только
 * первые три слота, и серый с коричневым там читаются как «отчёт не докрасился». Поэтому оба они
 * в конце: до них дело доходит на компании с десятком менеджеров, где важнее уже различимость.
 */
export const CHART_SLOTS = [4, 3, 6, 2, 12, 9, 5, 1, 10, 7, 8, 11] as const

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
  // ⚠ Инициал берём, только если вторая часть похожа на имя. Уволенный сотрудник, которого
  // `user.get` не отдал, подписан «Сотрудник #5562», и общее правило схлопнуло бы всех таких в
  // «Сотрудник #.» — то есть сделало бы неразличимыми ровно тех, кого различить и надо. Такую
  // подпись оставляем целиком: её обрежет по ширине кольца сама диаграмма.
  if (!first || !/^\p{L}/u.test(first)) return name.trim()
  return `${surname} ${first.slice(0, 1)}.`
}

export function managerChart(report: ManagerLoadReport, company: ManagerLoadCompany | undefined): ManagerChart {
  const nodes: SunburstNode[] = []
  const refs: Record<string, ManagerCellRef> = {}
  if (!company) return { nodes, refs }
  const stageName = new Map(report.stages.map(stage => [stage.id, stage.name]))

  // ⚠ Название компании в заголовке списка — `companyFullLabel`, тот же, что берёт таблица. У
  // группы без «моей компании» подписи две: «Не указана» в таблице и легенде (там рядом есть
  // заголовок про «мою компанию») и «Без моей компании» в заголовке списка, где такого заголовка
  // нет. Возьмёшь здесь `companyName` — одно и то же число откроет список с разными заголовками
  // в зависимости от того, где по нему нажали.
  const companyLabel = companyFullLabel(company.companyId, company.companyName)

  company.rows.forEach((row, index) => {
    const key = pairKey(company.companyId, row.managerId)
    refs[key] = {
      companyId: company.companyId,
      managerId: row.managerId,
      title: `Сделки: ${companyLabel} · ${row.managerName}`,
      total: row.total
    }
    // Кольцо рисует первых, легенда — всех. Ссылки на список нужны и тем и другим, а сектор —
    // только первым: тринадцатый сектор из одной сделки не читается ни при каком цвете.
    if (index >= CHART_MANAGERS) return
    const managerNode: SunburstNode = {
      key,
      label: row.managerName,
      short: shortManagerName(row.managerName),
      value: row.total,
      children: []
    }
    // Стадии — только те, что есть в таблице: колонки и кольцо обязаны показывать одно и то же.
    for (const stage of report.stages) {
      const value = row.byStage[stage.id] ?? 0
      if (value <= 0) continue
      const cell = cellKey(company.companyId, row.managerId, stage.id)
      managerNode.children!.push({ key: cell, label: stage.name, value })
      refs[cell] = {
        companyId: company.companyId,
        managerId: row.managerId,
        stageId: stage.id,
        title: `Сделки: ${companyLabel} · ${row.managerName} · ${stageName.get(stage.id) ?? stage.id}`,
        total: value
      }
    }
    nodes.push(managerNode)
  })

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
