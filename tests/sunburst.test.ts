import { describe, expect, it } from 'vitest'
import { DEFAULT_SUNBURST, sunburstArcs, sunburstDepth, type SunburstNode } from '~/utils/sunburst'

/**
 * Геометрия многокольцевой диаграммы. Проверяем ровно то, что ломается молча: доли, вложенность
 * колец и случаи, где SVG рисует не то, что просили (полный круг, дуга отрицательной ширины).
 */

const TREE: SunburstNode[] = [
  {
    key: 'a',
    label: 'Минск',
    value: 30,
    children: [
      { key: 'a1', label: 'Иванов', value: 20, children: [{ key: 'a1n', label: 'Новая', value: 12 }] },
      { key: 'a2', label: 'Петров', value: 10 }
    ]
  },
  { key: 'b', label: 'Гомель', value: 10 }
]

describe('sunburstArcs', () => {
  it('доли считаются от суммы корней и не зависят от кольца', () => {
    const arcs = sunburstArcs(TREE)
    const byKey = Object.fromEntries(arcs.map(arc => [arc.key, arc]))
    expect(byKey.a!.share).toBeCloseTo(0.75)
    expect(byKey.b!.share).toBeCloseTo(0.25)
    expect(byKey.a1!.share).toBeCloseTo(0.5)
    expect(byKey.a1n!.share).toBeCloseTo(0.3)
  })

  it('кольца идут от центра наружу, цвет берётся от корня ветки', () => {
    const arcs = sunburstArcs(TREE)
    expect(arcs.map(arc => arc.key)).toEqual(['a', 'b', 'a1', 'a2', 'a1n'])
    expect(arcs.map(arc => arc.depth)).toEqual([0, 0, 1, 1, 2])
    expect(arcs.find(arc => arc.key === 'a1n')!.rootKey).toBe('a')
    expect(sunburstDepth(arcs)).toBe(3)
  })

  /**
   * ⚠ Главное отличие от готовых библиотек, и оно намеренное: дети НЕ растягиваются на весь
   * сектор родителя. У «моей компании» есть сделки без ответственного, и растянутый ребёнок
   * показал бы 20 сделок как 30 — то есть соврал бы ровно там, где отчёт обязан быть точным.
   */
  it('дети не растягиваются на сектор родителя — остаток остаётся пустым', () => {
    const arcs = sunburstArcs([
      { key: 'p', label: 'Родитель', value: 100, children: [{ key: 'c', label: 'Ребёнок', value: 25 }] }
    ])
    const child = arcs.find(arc => arc.key === 'c')!
    expect(child.share).toBeCloseTo(0.25)
  })

  // Счётчики приходят разными пакетами, и на живом портале сумма детей бывает БОЛЬШЕ родителя:
  // сделку успели передать между двумя вопросами. Без обрезки сектор уехал бы на соседа.
  it('дети, переросшие родителя, обрезаются по его сектору', () => {
    const arcs = sunburstArcs([
      { key: 'p', label: 'Родитель', value: 10, children: [{ key: 'c1', label: 'Раз', value: 8 }, { key: 'c2', label: 'Два', value: 8 }] },
      { key: 'q', label: 'Сосед', value: 10 }
    ])
    // Оба ребёнка нарисованы, но вместе они не шире родителя — иначе второй лёг бы на соседа.
    expect(arcs.filter(arc => arc.depth === 1).length).toBe(2)
    expect(arcs.every(arc => arc.path.length > 0)).toBe(true)
  })

  // «Данных нет» и «всё пришлось на одну компанию» — разные утверждения.
  it('пустой вход и нулевые значения дают пустой массив', () => {
    expect(sunburstArcs([])).toEqual([])
    expect(sunburstArcs([{ key: 'a', label: 'Ноль', value: 0 }])).toEqual([])
    expect(sunburstArcs([{ key: 'a', label: 'Мусор', value: Number.NaN }])).toEqual([])
  })

  /**
   * ⚠ Дуга на 360° в SVG рисует ПУСТОТУ: у неё совпадают начало и конец, и спецификация
   * предписывает выбрасывать такую дугу целиком. Единственный корень — живой случай (одна
   * компания на портале), и кольцо должно остаться кольцом.
   */
  it('единственный корень рисуется полным кольцом, а не пустотой', () => {
    const arcs = sunburstArcs([{ key: 'only', label: 'Одна', value: 5 }])
    expect(arcs).toHaveLength(1)
    expect(arcs[0]!.path).toContain('A')
    expect(arcs[0]!.share).toBe(1)
  })

  /**
   * ⚠ Одна сделка из тысячи — это треть градуса. После вычета зазоров такая дуга становится
   * отрицательной, а SVG разворачивает её «в другую сторону» на весь круг: клякса поверх всей
   * диаграммы. Поэтому слишком узкие сектора не рисуются вовсе.
   */
  it('слишком узкий сектор не рисуется, но место в круге занимает', () => {
    const arcs = sunburstArcs([
      { key: 'big', label: 'Много', value: 10_000 },
      { key: 'tiny', label: 'Одна', value: 1 }
    ])
    expect(arcs.map(arc => arc.key)).toEqual(['big'])
  })

  it('зазор не съедает узкие сектора целиком', () => {
    const arcs = sunburstArcs([
      { key: 'a', label: 'A', value: 100 },
      { key: 'b', label: 'B', value: 1 }
    ], { ...DEFAULT_SUNBURST, gapDegrees: 6, minDegrees: 0.5 })
    expect(arcs.map(arc => arc.key)).toEqual(['a', 'b'])
    expect(arcs[1]!.path).not.toContain('NaN')
  })
})
