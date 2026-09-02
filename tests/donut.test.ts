import { describe, expect, it } from 'vitest'
import { DEFAULT_DONUT, donutSegments } from '~/utils/donut'

describe('donutSegments', () => {
  it('считает доли от суммы значений', () => {
    const segments = donutSegments([{ key: 'a', value: 3 }, { key: 'b', value: 1 }])
    expect(segments.map(s => s.share)).toEqual([0.75, 0.25])
  })

  it('каждому сегменту отдаёт готовый путь', () => {
    const segments = donutSegments([{ key: 'a', value: 1 }, { key: 'b', value: 1 }])
    expect(segments).toHaveLength(2)
    for (const s of segments) expect(s.path).toMatch(/^M [\d.-]+ [\d.-]+ A /)
  })

  // «Данных нет» и «всё пришлось на одну причину» рисуются одинаково, если этого не различать.
  it('пустой вход и нулевая сумма дают пустой массив', () => {
    expect(donutSegments([])).toEqual([])
    expect(donutSegments([{ key: 'a', value: 0 }])).toEqual([])
  })

  it('нулевые значения выбрасываются, а не превращаются в зазор', () => {
    const segments = donutSegments([{ key: 'a', value: 5 }, { key: 'b', value: 0 }])
    expect(segments.map(s => s.key)).toEqual(['a'])
    expect(segments[0]!.share).toBe(1)
  })

  it('отрицательные значения игнорируются', () => {
    expect(donutSegments([{ key: 'a', value: -1 }, { key: 'b', value: 2 }]).map(s => s.key)).toEqual(['b'])
  })

  it('геометрия настраивается', () => {
    const wide = donutSegments([{ key: 'a', value: 1 }, { key: 'b', value: 1 }], { ...DEFAULT_DONUT, radius: 30 })
    expect(wide[0]!.path).toContain('A 30 30')
  })

  // Сегмент уже зазора: наивная арифметика дала бы отрицательный размах, и SVG развернул бы дугу
  // «в другую сторону» — на весь круг поверх остальных.
  it('сегмент тоньше зазора не разворачивает дугу на весь круг', () => {
    const segments = donutSegments([{ key: 'big', value: 10_000 }, { key: 'tiny', value: 1 }])
    expect(segments).toHaveLength(2)
    expect(segments[1]!.path).not.toContain('1 1 ')
  })
})
