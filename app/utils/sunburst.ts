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
  /**
   * Короткая подпись для сектора, если полная туда не влезет: «Авдеева М.» вместо «Авдеева
   * Мария». В подсказке и в легенде всё равно остаётся `label` — сокращение нужно только там,
   * где место меряется миллиметрами кольца.
   */
  short?: string
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

/**
 * Кольца в единицах viewBox 100 × 100: центр 50, внешний радиус 48.
 *
 * ⚠ Кольца ТОЛСТЫЕ не для красоты: в них пишутся подписи — имена менеджеров и названия стадий,
 * как в прежнем отчёте заказчика. При тонком кольце в сектор влезало бы три буквы, и подписи
 * пришлось бы убрать, оставив человека наедине с цветными дугами и легендой сбоку.
 */
export const DEFAULT_SUNBURST: SunburstGeometry = {
  innerRadius: 11,
  ringThickness: 18.5,
  gapDegrees: 0.8,
  minDegrees: 0.4
}

export interface SunburstArc {
  key: string
  label: string
  value: number
  /** Доля от суммы корней, 0…1 — её показывает подсказка и легенда. */
  share: number
  /** Номер кольца: 0 — внутреннее. */
  depth: number
  /** Ключ корневого предка: по нему берётся цвет, чтобы кольца одной ветки были одного тона. */
  rootKey: string
  /** Подпись для сектора: короткая, если она задана узлом. */
  short: string
  /** Готовый атрибут `d` для `<path>`. */
  path: string
  /**
   * Куда и как писать подпись прямо в секторе — как в прежнем отчёте заказчика, где имена
   * менеджеров и названия стадий читались с самой диаграммы, а не только из легенды.
   *
   * `along` — место вдоль радиуса (толщина кольца), `across` — поперёк.
   *
   * ⚠ `across` меряется по ВНУТРЕННЕЙ кромке дуги и по ширине ЗА ВЫЧЕТОМ зазора, а не по
   * середине кольца и не по полному сектору. Подпись повёрнута вдоль радиуса, то есть занимает
   * всю толщину кольца, и её узкий конец лежит на внутренней кромке, где дуга при том же угле
   * почти вдвое короче (на первом кольце 11 против 20,25). Мерка «по середине» разрешала бы
   * подпись там, где её нижний край уже лезет на соседа.
   */
  labelAt: { x: number, y: number, rotate: number, along: number, across: number }
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
    //
    // ⚠ У сектора, занимающего ВЕСЬ круг, зазора нет вовсе: отрезать его не от чего — соседей у
    // такого сектора нет, а прорезь на двенадцати часах читается как дефект отрисовки. Случай
    // живой: у заказчика «моя компания» заполнена у 8 % сделок, и направление с одной компанией
    // (или с одним менеджером внутри неё) — обычное дело.
    const gap = span >= 359.99 ? 0 : Math.min(geometry.gapDegrees, span / 3)
    // Подпись ставится по СЕРЕДИНЕ кольца и поворачивается вдоль радиуса: так её ширина
    // ограничена толщиной кольца, а не длиной дуги, и одинаково читается в любой части круга.
    const middle = (item.start + item.end) / 2
    const midRadius = (inner + outer) / 2
    const radians = ((middle - 90) * Math.PI) / 180
    // Самое узкое место подписи: внутренняя кромка дуги, уже урезанной зазором.
    const across = ((span - gap) * Math.PI / 180) * inner
    arcs.push({
      key: item.node.key,
      label: item.node.label,
      short: item.node.short ?? item.node.label,
      value: item.node.value,
      share: item.node.value / total,
      depth: item.depth,
      rootKey: item.rootKey,
      path: ringSlice(center, center, outer, inner, item.start + gap / 2, item.end - gap / 2),
      labelAt: {
        x: center + midRadius * Math.cos(radians),
        y: center + midRadius * Math.sin(radians),
        // ⚠ В левой половине круга текст переворачиваем: иначе он идёт вверх ногами, а такое
        // читается не лучше, чем его отсутствие.
        rotate: middle > 180 ? middle + 90 : middle - 90,
        along: outer - inner,
        across: Math.max(0, across)
      }
    })
  }
  return arcs
}

/**
 * Ширина символа в долях высоты шрифта — среднее по кириллице в системном шрифте.
 *
 * Точность здесь не нужна: ошибка в полсимвола означает лишнюю или недостающую букву перед
 * многоточием, а полное имя всё равно стоит в подсказке, в легенде и в таблице.
 */
const GLYPH_RATIO = 0.52

/** Отступ подписи от кромок кольца, единицы viewBox: вплотную к краю текст читается как обрезанный. */
const LABEL_PADDING = 2.5

/**
 * Подпись сектора — или её отсутствие, если она туда не влезает.
 *
 * ⚠ Функция здесь, а не в шаблоне компонента, ровно по правилу проекта: это арифметика, а
 * арифметика в шаблоне не покрыта тестом и ломается молча. Компонент передаёт размер шрифта —
 * единственное, чего геометрия про себя не знает.
 *
 * ⚠ Дуга у́же строки — подписи НЕТ вовсе: текст, вылезший на соседний сектор, хуже пустого
 * сектора, потому что подписывает чужие сделки чужим именем.
 */
export function sunburstLabel(
  // Берём ровно то, что нужно, а не весь `SunburstArc`: подпись не зависит ни от места сектора в
  // круге, ни от его наклона — только от размеров, куда она должна поместиться.
  arc: { short: string, labelAt: { along: number, across: number } },
  fontSize: number
): string | undefined {
  if (arc.labelAt.across < fontSize * 1.25) return undefined
  const fits = Math.floor((arc.labelAt.along - LABEL_PADDING) / (fontSize * GLYPH_RATIO))
  // Меньше трёх букв — это не подпись, а шум: «Ав…» не отличает Авдееву от Авдеенко.
  if (fits < 3) return undefined
  return arc.short.length > fits ? `${arc.short.slice(0, Math.max(1, fits - 1))}…` : arc.short
}

/** Сколько колец получилось — по нему экран решает, что писать в легенде. */
export function sunburstDepth(arcs: readonly SunburstArc[]): number {
  return arcs.reduce((max, arc) => Math.max(max, arc.depth + 1), 0)
}
