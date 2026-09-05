import { ringSlice } from '~/utils/donut'

/**
 * Геометрия многокольцевой диаграммы («солнечные лучи», sunburst): дерево значений → SVG-дуги.
 *
 * Такая диаграмма была в прежнем отчёте заказчика «Незакрытые заказы» на самом портале: три
 * кольца «моя компания → ответственный → стадия», крупно, с легендой рядом. Там её рисовал
 * amCharts; здесь она своя и по той же причине, что и кольцо блока брака (`donut.ts`) — считать
 * тут нечего, а любая charting-библиотека тянет в статику сотни килобайт и свою тему, которую
 * пришлось бы мирить с b24ui. Зато арифметика оказывается чистой функцией и проверяется тестом.
 *
 * ⚠ Главное отличие от amCharts, и оно намеренное: дуга ребёнка НЕ растягивается на всю дугу
 * родителя. Дети здесь могут не покрывать родителя целиком — у «моей компании» есть сделки без
 * ответственного, а у менеджера сделки на стадиях вне справочника. amCharts в такой ситуации
 * растянул бы детей на весь сектор, то есть показал бы 25 сделок как 30. Мы оставляем остаток
 * пустым: пустое место в кольце — честное «здесь мы не знаем», а растянутый сектор — неправда.
 */

/** Узел дерева: сам знает свой размер, дети — свои. */
export interface SunburstNode {
  key: string
  label: string
  value: number
  children?: SunburstNode[]
}

export interface SunburstGeometry {
  /** Радиус пустого центра — в него ставится итоговое число. */
  innerRadius: number
  /** Толщина одного кольца. */
  ringThickness: number
  /** Зазор между соседями по кругу, градусы. */
  gapDegrees: number
  /**
   * Дуга уже этого (в градусах) не рисуется вовсе.
   *
   * ⚠ Не оптимизация: на боевом портале у менеджера бывает одна сделка из тысячи, её сектор — три
   * десятых градуса, и после вычета зазоров он превращается в дугу отрицательной ширины. SVG
   * разворачивает такую в дугу «в другую сторону» — то есть в кляксу на весь круг.
   */
  minDegrees: number
}

/** Кольца в единицах viewBox 100 × 100: центр 50, внешний радиус 49. */
export const DEFAULT_SUNBURST: SunburstGeometry = {
  innerRadius: 17,
  ringThickness: 10.5,
  gapDegrees: 1.2,
  minDegrees: 0.6
}

export interface SunburstArc {
  key: string
  label: string
  value: number
  /** Доля от суммы корней, 0…1 — её показывает подсказка и легенда. */
  share: number
  /** Номер кольца: 0 — внутреннее. */
  depth: number
  /** Ключ корневого предка: по нему берётся цвет, чтобы кольца одной компании были одного тона. */
  rootKey: string
  /** Готовый атрибут `d` для `<path>`. */
  path: string
}

interface Layout {
  node: SunburstNode
  depth: number
  rootKey: string
  /** Границы сектора в градусах от 12 часов по часовой стрелке. */
  start: number
  end: number
}

const center = 50

/**
 * Дуги всех колец.
 *
 * Пустой вход и нулевая сумма дают пустой массив, а не круг из первого элемента: «данных нет» и
 * «всё пришлось на одну компанию» — разные утверждения, и рисовать их одинаково нельзя.
 */
export function sunburstArcs(
  nodes: readonly SunburstNode[],
  geometry: SunburstGeometry = DEFAULT_SUNBURST
): SunburstArc[] {
  const roots = nodes.filter(node => Number.isFinite(node.value) && node.value > 0)
  const total = roots.reduce((sum, node) => sum + node.value, 0)
  if (total <= 0) return []

  // Раскладка по углам — обходом в ширину: сначала все корни, потом их дети. Так дуги приходят
  // от центра наружу, и в SVG внешние кольца рисуются поверх внутренних, а не наоборот.
  const queue: Layout[] = []
  let cursor = 0
  for (const node of roots) {
    const sweep = (node.value / total) * 360
    queue.push({ node, depth: 0, rootKey: node.key, start: cursor, end: cursor + sweep })
    cursor += sweep
  }

  const arcs: SunburstArc[] = []
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!
    const span = item.end - item.start
    // Сектор родителя занят детьми ровно настолько, насколько они его покрывают, — см. ⚠ выше.
    const degreesPerUnit = span / item.node.value
    let childCursor = item.start
    for (const child of item.node.children ?? []) {
      if (!Number.isFinite(child.value) || child.value <= 0) continue
      // ⚠ Обрезаем по остатку сектора родителя, а не по его полной ширине. Счётчики приходят
      // разными пакетами, и на живом портале сумма детей бывает БОЛЬШЕ родителя (сделку успели
      // передать между вопросами). Без обрезки последний ребёнок уехал бы за пределы сектора и
      // лёг поверх соседней компании — то есть нарисовал бы её сделки своим цветом.
      const childSpan = Math.min(child.value * degreesPerUnit, item.end - childCursor)
      if (childSpan <= 0) continue
      queue.push({
        node: child,
        depth: item.depth + 1,
        rootKey: item.rootKey,
        start: childCursor,
        end: childCursor + childSpan
      })
      childCursor += childSpan
    }

    if (span < geometry.minDegrees) continue
    const outer = geometry.innerRadius + geometry.ringThickness * (item.depth + 1)
    const inner = geometry.innerRadius + geometry.ringThickness * item.depth
    // Зазор режется ИЗНУТРИ сектора, но не больше трети его ширины: у тонких дуг он съел бы их
    // целиком, и кольцо стало бы пунктиром из ничего.
    const gap = Math.min(geometry.gapDegrees, span / 3)
    arcs.push({
      key: item.node.key,
      label: item.node.label,
      value: item.node.value,
      share: item.node.value / total,
      depth: item.depth,
      rootKey: item.rootKey,
      path: ringSlice(center, center, outer, inner, item.start + gap / 2, item.end - gap / 2)
    })
  }
  return arcs
}

/** Сколько колец получилось — по нему экран решает, что писать в легенде. */
export function sunburstDepth(arcs: readonly SunburstArc[]): number {
  return arcs.reduce((max, arc) => Math.max(max, arc.depth + 1), 0)
}
