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

/** Дуга кольца (внешняя дуга вперёд, внутренняя назад) как замкнутый контур. */
function ringSlice(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startDeg: number,
  endDeg: number
): string {
  const sweep = endDeg - startDeg
  const largeArc = sweep > 180 ? 1 : 0
  const [ox1, oy1] = pointAt(cx, cy, outer, startDeg)
  const [ox2, oy2] = pointAt(cx, cy, outer, endDeg)
  const [ix2, iy2] = pointAt(cx, cy, inner, endDeg)
  const [ix1, iy1] = pointAt(cx, cy, inner, startDeg)
  return [
    `M ${ox1.toFixed(3)} ${oy1.toFixed(3)}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${ox2.toFixed(3)} ${oy2.toFixed(3)}`,
    `L ${ix2.toFixed(3)} ${iy2.toFixed(3)}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${ix1.toFixed(3)} ${iy1.toFixed(3)}`,
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
