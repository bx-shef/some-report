import { describe, expect, it } from 'vitest'
import { DEFAULT_DONUT, donutSegments } from '~/utils/donut'

/** Флаги `large-arc-flag` всех дуг пути — по ним видно геометрию, а не форматирование чисел. */
function arcFlags(path: string): number[] {
  return [...path.matchAll(/A [\d.]+ [\d.]+ 0 (\d) \d/g)].map(m => Number(m[1]))
}

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
  //
  // ⚠ Проверяем ФЛАГ большой дуги, а не отсутствие подстроки: прежняя проверка `not.toContain`
  // краснела бы от смены `toFixed(3)` на `toFixed(2)` и молчала бы при реально сломанной
  // геометрии. Флаг `large-arc-flag = 1` — это и есть «дуга длиннее полукруга».
  it('сегмент тоньше зазора не разворачивает дугу на весь круг', () => {
    const segments = donutSegments([{ key: 'big', value: 10_000 }, { key: 'tiny', value: 1 }])
    expect(segments).toHaveLength(2)
    expect(arcFlags(segments[1]!.path)).toEqual([0, 0])
  })

  /**
   * ⚠ Регрессия, найденная на ревью. У дуги на 360° концы СОВПАДАЮТ, и спецификация SVG велит
   * выбрасывать такую дугу целиком — кольцо не рисовалось вовсе. Случай живой: весь брак за
   * период пришёлся на одну причину, и человек видел легенду «100 %» рядом с пустотой.
   */
  describe('кольцо целиком (одна причина на 100 %)', () => {
    const [segment] = donutSegments([{ key: 'only', value: 250 }])

    it('сегмент есть и занимает всё кольцо', () => {
      expect(segment).toBeDefined()
      expect(segment!.share).toBe(1)
    })

    it('дуга разрезана надвое — ни одна не имеет совпадающих концов', () => {
      const points = [...segment!.path.matchAll(/[AL] [\d.]+ [\d.]+ 0 \d \d ([\d.-]+) ([\d.-]+)|M ([\d.-]+) ([\d.-]+)/g)]
      // Четыре дуги (две внешние + две внутренние) плюс перемычка и M — концы не сходятся в одну точку.
      expect(segment!.path.match(/A /g)).toHaveLength(4)
      expect(points.length).toBeGreaterThan(2)
    })

    it('контур замкнут', () => {
      expect(segment!.path.trimEnd().endsWith('Z')).toBe(true)
    })
  })

  it('центр кольца настраивается', () => {
    // Один сегмент — зазора нет, поэтому старт ровно на 12 часов от центра: y = центр − радиус.
    const [segment] = donutSegments([{ key: 'a', value: 1 }], DEFAULT_DONUT, 200)
    expect(segment!.path.startsWith('M 200.000 154.000')).toBe(true)
  })

  it('сегмент больше полукруга помечен флагом большой дуги', () => {
    const segments = donutSegments([{ key: 'big', value: 3 }, { key: 'small', value: 1 }])
    expect(arcFlags(segments[0]!.path)).toEqual([1, 1])
    expect(arcFlags(segments[1]!.path)).toEqual([0, 0])
  })
})
