import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import { plainParams } from '~/utils/b24Params'

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
    const dictionaries = reactive({ lossReasonCodes: { дорого: ['LOSE', 'C4:APOLOGY'] } })
    const filter = { STAGE_ID: dictionaries.lossReasonCodes.дорого }

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
    const source = reactive({ filter: { STAGE_ID: ['LOSE'] } })
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

  /** Развёрнутый `ref` — тоже `Proxy` внутри: проверка на самом частом способе достать данные. */
  it('условие, собранное из ref, тоже очищается', () => {
    const dataset = ref({ dictionaries: { lossReasonCodes: { дорого: ['LOSE'] } } })
    const filter = { STAGE_ID: dataset.value.dictionaries.lossReasonCodes.дорого, STAGE_SEMANTIC_ID: 'F' }
    expect(() => structuredClone(filter)).toThrow()
    expect(plainParams(filter)).toEqual({ STAGE_ID: ['LOSE'], STAGE_SEMANTIC_ID: 'F' })
  })
})
