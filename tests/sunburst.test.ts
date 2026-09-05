import { describe, expect, it } from 'vitest'
import { DEFAULT_SUNBURST, sunburstArcs, sunburstLabel, sunburstDepth, type SunburstNode } from '~/utils/sunburst'

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
   * ⚠ И БЕЗ ПРОРЕЗИ: у сектора на весь круг соседей нет, отрезать зазор не от чего, а щель на
   * двенадцати часах читается как дефект отрисовки. Случай живой — направление с одной «моей
   * компанией» или с одним менеджером внутри неё. Сравниваем с кольцом, нарисованным при нулевом
   * зазоре: пути обязаны совпасть.
   */
  it('кольцо целиком идёт без зазора', () => {
    const single = [{ key: 'only', label: 'Одна', value: 5 }]
    const withGap = sunburstArcs(single, { ...DEFAULT_SUNBURST, gapDegrees: 12 })
    const withoutGap = sunburstArcs(single, { ...DEFAULT_SUNBURST, gapDegrees: 0 })
    expect(withGap[0]!.path).toBe(withoutGap[0]!.path)
  })

  // Единственный ребёнок, покрывающий родителя целиком, — тот же случай кольцом дальше от центра.
  it('единственный ребёнок на весь сектор родителя тоже без зазора', () => {
    const tree = [{ key: 'p', label: 'Родитель', value: 5, children: [{ key: 'c', label: 'Ребёнок', value: 5 }] }]
    const withGap = sunburstArcs(tree, { ...DEFAULT_SUNBURST, gapDegrees: 12 })
    const withoutGap = sunburstArcs(tree, { ...DEFAULT_SUNBURST, gapDegrees: 0 })
    expect(withGap.map(arc => arc.path)).toEqual(withoutGap.map(arc => arc.path))
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

/**
 * Подписи прямо в секторах — то, ради чего кольца сделаны толстыми. Геометрия отдаёт место, а
 * `sunburstLabel` решает, влезет ли туда строка: обе части чистые и обе под тестом, потому что
 * решение «влезет» в шаблоне компонента не проверялось бы ничем.
 */
describe('подписи секторов', () => {
  const HALVES = [
    { key: 'right', label: 'Правая', value: 1 },
    { key: 'left', label: 'Левая', value: 1 }
  ]

  it('короткая подпись берётся у узла, а без неё — полная', () => {
    const arcs = sunburstArcs([
      { key: 'a', label: 'Авдеева Мария', short: 'Авдеева М.', value: 1 },
      { key: 'b', label: 'Новая', value: 1 }
    ])
    expect(arcs.map(arc => arc.short)).toEqual(['Авдеева М.', 'Новая'])
  })

  /**
   * ⚠ Подпись НИКОГДА не встаёт вверх ногами. Вдоль радиуса её можно повернуть двумя способами,
   * и в левой половине круга «естественный» поворот даёт перевёрнутый текст — читается он не
   * лучше, чем его отсутствие. Проверяем свойство, а не конкретные градусы: смысл в том, что
   * наклон нормализуется в (−90°, 90°], то есть буквы всегда стоят на ногах.
   */
  it('подпись не встаёт вверх ногами ни в одной части круга', () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ key: `k${i}`, label: `Сектор ${i}`, value: 1 }))
    for (const arc of sunburstArcs(many)) {
      const tilt = ((arc.labelAt.rotate % 360) + 540) % 360 - 180
      expect(Math.abs(tilt), `сектор ${arc.key} наклонён на ${arc.labelAt.rotate}°`).toBeLessThanOrEqual(90)
    }
  })

  it('место под подписью: вдоль радиуса — толщина кольца', () => {
    const arcs = sunburstArcs(HALVES)
    expect(arcs[0]!.labelAt.along).toBe(DEFAULT_SUNBURST.ringThickness)
  })

  /**
   * ⚠ Поперёк меряем по ВНУТРЕННЕЙ кромке дуги и по ширине за вычетом зазора — по самому узкому
   * её месту. Мерка «по середине кольца» разрешала бы подпись там, где её нижний край уже лезет
   * на соседний сектор: на первом кольце внутренний радиус 11 против 20,25 по середине.
   */
  it('место поперёк меряется по внутренней кромке, а не по середине кольца', () => {
    const [arc] = sunburstArcs(HALVES)
    const gap = DEFAULT_SUNBURST.gapDegrees
    expect(arc!.labelAt.across).toBeCloseTo(((180 - gap) * Math.PI / 180) * DEFAULT_SUNBURST.innerRadius, 5)
  })

  it('единственный корень занимает круг целиком и подписан внизу', () => {
    const [arc] = sunburstArcs([{ key: 'one', label: 'Одна', value: 7 }])
    const midRadius = DEFAULT_SUNBURST.innerRadius + DEFAULT_SUNBURST.ringThickness / 2
    expect(arc!.labelAt.x).toBeCloseTo(50, 5)
    expect(arc!.labelAt.y).toBeCloseTo(50 + midRadius, 5)
  })
})

describe('sunburstLabel', () => {
  const wide = { short: 'Авдеева М.', labelAt: { along: 18.5, across: 30 } }

  it('широкая дуга — подпись целиком', () => {
    expect(sunburstLabel(wide, 2.9)).toBe('Авдеева М.')
  })

  /**
   * ⚠ Текст, вылезший на соседний сектор, ХУЖЕ пустого сектора: он подписывает чужие сделки
   * чужим именем. Поэтому узкая дуга остаётся без подписи вовсе.
   */
  it('дуга у́же строки остаётся без подписи', () => {
    expect(sunburstLabel({ ...wide, labelAt: { along: 18.5, across: 3 } }, 2.9)).toBeUndefined()
  })

  it('тонкое кольцо, куда влезло бы две буквы, тоже без подписи', () => {
    expect(sunburstLabel({ ...wide, labelAt: { along: 5, across: 30 } }, 2.9)).toBeUndefined()
  })

  it('длинное имя обрезается многоточием по ширине кольца', () => {
    const label = sunburstLabel({ short: 'Барановский И.', labelAt: { along: 12, across: 30 } }, 2.9)
    expect(label).toBe('Баран…')
  })
})
