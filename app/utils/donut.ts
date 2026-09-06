/**
 * Арифметика кольцевой диаграммы: доли → SVG-дуги.
 *
 * Своя, а не библиотечная, ровно по одной причине — считать здесь нечего (четыре дуги), а любая
 * charting-библиотека тянет в статику сотни килобайт и свою тему, которую пришлось бы мирить с
 * b24ui. Зато арифметика оказывается чистой функцией и проверяется тестами, чего с библиотекой
 * не сделать.
 */

export interface DonutSegmentInput {
  key: string
  value: number
}

export interface DonutSegment extends DonutSegmentInput {
  /** Доля 0…1 от суммы значений. */
  share: number
  /** Готовый атрибут `d` для `<path>`. */
  path: string
}

export interface DonutGeometry {
  /** Внешний радиус в единицах viewBox. */
  radius: number
  /** Толщина кольца. */
  thickness: number
  /** Зазор между сегментами в градусах — те самые «2 px поверхностью», только в углах. */
  gapDegrees: number
}

export const DEFAULT_DONUT: DonutGeometry = { radius: 46, thickness: 18, gapDegrees: 2 }

/** Точка на окружности. Угол считается от 12 часов по часовой стрелке. */
function pointAt(cx: number, cy: number, r: number, degrees: number): [number, number] {
  const rad = ((degrees - 90) * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

const xy = (p: [number, number]) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`

/**
 * Кольцо целиком — отдельный случай, и это не микрооптимизация.
 *
 * ⚠ У дуги на 360° начальная и конечная точки СОВПАДАЮТ, а спецификация SVG предписывает такую
 * дугу выбрасывать целиком («equivalent to omitting the elliptical arc segment entirely»).
 * То есть наивный «сегмент от 0° до 360°» рисует ПУСТОТУ. Случай живой: весь брак за период
 * пришёлся на одну причину — и блок показывал легенду «100 %» рядом с ничем.
 *
 * Лечится разбиением на две дуги по 180°. Внешняя идёт по часовой (флаг развёртки 1), внутренняя
 * против (0) — противоположная намотка и оставляет дырку при заливке nonzero.
 */
function fullRing(cx: number, cy: number, outer: number, inner: number): string {
  return [
    `M ${xy(pointAt(cx, cy, outer, 0))}`,
    `A ${outer} ${outer} 0 0 1 ${xy(pointAt(cx, cy, outer, 180))}`,
    `A ${outer} ${outer} 0 0 1 ${xy(pointAt(cx, cy, outer, 359.999))}`,
    `L ${xy(pointAt(cx, cy, inner, 359.999))}`,
    `A ${inner} ${inner} 0 0 0 ${xy(pointAt(cx, cy, inner, 180))}`,
    `A ${inner} ${inner} 0 0 0 ${xy(pointAt(cx, cy, inner, 0))}`,
    'Z'
  ].join(' ')
}

/**
 * Дуга кольца (внешняя дуга вперёд, внутренняя назад) как замкнутый контур.
 *
 * Экспортируется ради `sunburst.ts`: у многокольцевой диаграммы та же арифметика дуг, и второй
 * её экземпляр разошёлся бы с этим ровно на случае «кольцо целиком» (см. `fullRing`).
 */
export function ringSlice(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startDeg: number,
  endDeg: number
): string {
  const sweep = endDeg - startDeg
  if (sweep >= 360) return fullRing(cx, cy, outer, inner)
  const largeArc = sweep > 180 ? 1 : 0
  return [
    `M ${xy(pointAt(cx, cy, outer, startDeg))}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${xy(pointAt(cx, cy, outer, endDeg))}`,
    `L ${xy(pointAt(cx, cy, inner, endDeg))}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${xy(pointAt(cx, cy, inner, startDeg))}`,
    'Z'
  ].join(' ')
}

/**
 * Сегменты кольца по значениям.
 *
 * Пустой вход и нулевая сумма дают пустой массив, а не кольцо на 360° из первого элемента:
 * «данных нет» и «всё пришлось на одну причину» — разные утверждения, и рисовать их одинаково
 * нельзя. Нулевые значения выбрасываются: сегмент нулевой ширины превращается в зазор и врёт
 * легенде.
 */
export function donutSegments(
  input: DonutSegmentInput[],
  geometry: DonutGeometry = DEFAULT_DONUT,
  center = 50
): DonutSegment[] {
  const items = input.filter(i => Number.isFinite(i.value) && i.value > 0)
  const total = items.reduce((sum, i) => sum + i.value, 0)
  if (total <= 0) return []

  const inner = Math.max(0, geometry.radius - geometry.thickness)
  // Зазор режется ИЗНУТРИ сегмента, поэтому единственный сегмент остаётся целым кольцом:
  // отрезать зазор у самого себя ему не от чего.
  const gap = items.length > 1 ? geometry.gapDegrees : 0

  let cursor = 0
  return items.map((item) => {
    const sweep = (item.value / total) * 360
    const start = cursor + gap / 2
    const end = cursor + sweep - gap / 2
    cursor += sweep
    return {
      ...item,
      share: item.value / total,
      // Сегмент тоньше зазора рисуем волоском в его середине, а не отрицательной дугой:
      // отрицательный размах SVG разворачивает в дугу «в другую сторону» на весь круг.
      path: end > start
        ? ringSlice(center, center, geometry.radius, inner, start, end)
        : ringSlice(center, center, geometry.radius, inner, cursor - sweep / 2, cursor - sweep / 2 + 0.01)
    }
  })
}
