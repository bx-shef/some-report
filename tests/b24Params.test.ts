import { describe, expect, it } from 'vitest'
import { plainParams } from '~/utils/b24Params'

/**
 * Реактивность Vue — это `Proxy`, и здесь он делается РУКАМИ, без импорта `vue`.
 *
 * ⚠ Не для чистоты: проект `unit` — это голый Node без пайплайна Nuxt, и `vue` оттуда не
 * резолвится вовсе. Файл падал на импорте целиком, то есть главная проверка правки не
 * выполнялась НИ РАЗУ — при зелёном на вид прогоне. Структурному клонированию всё равно, чей
 * это `Proxy`: оно отказывается копировать любой.
 */
const asProxy = <T extends object>(value: T): T => new Proxy(value, {})

/**
 * Параметры запроса к порталу без реактивных обёрток.
 *
 * ⛔ Боевой отказ 2026-09-14: клик по причине проигрыша открывал слайдер с верным заголовком и
 * красной плашкой вместо списка — «Failed to execute 'structuredClone' on 'Window': [object
 * Object] could not be cloned». Фрейм говорит с порталом через `postMessage`, а тот клонирует
 * нагрузку СТРУКТУРНО и `Proxy` (то есть реактивность Vue) копировать не умеет.
 */
describe('plainParams', () => {
  /**
   * ⛔ Главная проверка: ДО функции запрос не переживает дорогу, ПОСЛЕ — переживает. Ровно этот
   * переход и был боевым дефектом, и записан он здесь одним утверждением, а не описан словами.
   */
  it('реактивное условие не переживает postMessage, а очищенное — переживает', () => {
    const filter = { STAGE_ID: asProxy(['LOSE', 'C4:APOLOGY']) }

    expect(() => structuredClone(filter)).toThrow()
    expect(() => structuredClone(plainParams(filter))).not.toThrow()
    expect(plainParams(filter)).toEqual({ STAGE_ID: ['LOSE', 'C4:APOLOGY'] })
  })

  /**
   * ⚠ Разворот объекта дефект НЕ лечит, и это причина, по которой он прожил так долго: сверху
   * обёртка снимается, и условия из строк работали годами. Первое же ПЕРЕЧИСЛЕНИЕ внутри — и
   * запрос падает целиком.
   */
  it('спреда мало: реактивным остаётся вложенное значение', () => {
    const source = { filter: { STAGE_ID: asProxy(['LOSE']) } }
    expect(() => structuredClone({ ...source.filter })).toThrow()
    expect(() => structuredClone(plainParams({ ...source.filter }))).not.toThrow()
  })

  /**
   * ⚠ `null` обязан доезжать: `'!LEAD_ID': null` — значимое условие REST («у сделки есть лид»),
   * а не «значения нет». Потеряй его копия — ВСЕ списки сделок отчёта по лидам открывали бы
   * записи без лида, то есть чужие.
   */
  it('null доезжает как условие, а не теряется', () => {
    expect(plainParams({ '!LEAD_ID': null, 'ID': [1, 2] })).toEqual({ '!LEAD_ID': null, 'ID': [1, 2] })
  })

  /**
   * ⚠ Значения не меняются вообще: числа остаются числами, вложенность — вложенностью. Копия,
   * которая «почти та же», давала бы список, не сходящийся с числом над ним.
   */
  it('копия равна исходнику по значению и не делится с ним памятью', () => {
    const params = { filter: { ID: [1, 2, 3] }, select: ['ID', 'TITLE'], order: { ID: 'ASC' }, start: -1 }
    const copy = plainParams(params)
    expect(copy).toEqual(params)
    expect(copy.filter).not.toBe(params.filter)
    expect(copy.filter.ID).not.toBe(params.filter.ID)
  })

  /** Смешанное условие: `Proxy` рядом с обычными значениями — как оно и собирается в отчёте. */
  it('условие с реактивным куском рядом с обычными очищается целиком', () => {
    const filter = { STAGE_ID: asProxy(['LOSE']), STAGE_SEMANTIC_ID: 'F' }
    expect(() => structuredClone(filter)).toThrow()
    expect(plainParams(filter)).toEqual({ STAGE_ID: ['LOSE'], STAGE_SEMANTIC_ID: 'F' })
  })

  /**
   * ⚠ `undefined` выбрасывается — и это заявлено в `b24Params.ts` как ПОЛЕЗНОЕ свойство: портал
   * видит «поля нет» ровно так же. Заявление закреплено тестом, иначе замена реализации на
   * другой способ копирования сменила бы поведение молча.
   */
  it('undefined выбрасывается, пустой объект остаётся пустым', () => {
    expect(plainParams({ STATUS_ID: undefined, SOURCE_ID: 'CALL' })).toEqual({ SOURCE_ID: 'CALL' })
    expect(plainParams({})).toEqual({})
  })

  /**
   * ⚠ Опасный ключ не должен портить прототип. `JSON.parse` кладёт `__proto__` обычным
   * собственным свойством, а не через сеттер, — но полагаться на неочевидную семантику нельзя:
   * функцию однажды применят к тому, что пришло снаружи.
   */
  it('опасный ключ не портит прототип', () => {
    const dirty = JSON.parse('{"__proto__": {"сломано": true}}') as Record<string, unknown>
    plainParams({ filter: dirty })
    expect(({} as Record<string, unknown>).сломано).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('сломано')
  })
})
