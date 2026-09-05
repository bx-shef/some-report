import { describe, expect, it } from 'vitest'
import {
  decodeLeadsState,
  decodeManagersState,
  encodeLeadsState,
  encodeManagersState,
  LEADS_OPTION_KEY,
  MANAGERS_OPTION_KEY
} from '~/utils/savedFilters'

/**
 * Отбор, запомненный порталом. Проверяем разбор: в настройках лежит то, что записала ПРОШЛАЯ
 * версия приложения и что человек мог унаследовать с другого портала. Восстановить негодное
 * молча значит открыть отчёт с отбором, которого никто не выбирал.
 */

const PERIOD = { from: '2026-09-01', to: '2026-09-30' }

describe('ключи настроек', () => {
  // Версия в ключе: формат отбора уже менялся дважды за две недели. Без неё старое значение
  // приехало бы в новый формат и было бы прочитано наполовину.
  it('несут версию формата', () => {
    expect(LEADS_OPTION_KEY).toMatch(/\.v\d+$/)
    expect(MANAGERS_OPTION_KEY).toMatch(/\.v\d+$/)
    expect(LEADS_OPTION_KEY).not.toBe(MANAGERS_OPTION_KEY)
  })
})

describe('отчёт по лидам', () => {
  it('туда и обратно — то же самое', () => {
    const filters = { sourceId: 'CALL', assignedById: 17 }
    expect(decodeLeadsState(encodeLeadsState(PERIOD, filters))).toEqual({ period: PERIOD, filters })
  })

  it('пустой отбор не восстанавливает пустых ключей', () => {
    expect(decodeLeadsState(encodeLeadsState(PERIOD, {}))).toEqual({ period: PERIOD })
  })

  // Портал отдаёт значение строкой; на всякий случай читаем и уже разобранный объект.
  it('читает и строку, и объект', () => {
    expect(decodeLeadsState({ period: PERIOD }).period).toEqual(PERIOD)
    expect(decodeLeadsState(JSON.stringify({ period: PERIOD })).period).toEqual(PERIOD)
  })

  it.each([
    ['мусор', 'не json'],
    ['пусто', ''],
    ['массив', '[1,2]'],
    ['ничего', undefined],
    ['число', 42]
  ])('%s — открываемся с умолчанием, а не падаем', (_name, value) => {
    expect(decodeLeadsState(value)).toEqual({})
  })

  /**
   * ⚠ Период проверяем той же проверкой, что и панель: иначе через настройки в отчёт заезжал бы
   * период, который через интерфейс выбрать нельзя, — перевёрнутый или длиной в пять лет. На
   * боевых объёмах второй случай — это минуты ожидания при открытии фрейма.
   */
  it.each([
    ['перевёрнутый', { from: '2026-09-30', to: '2026-09-01' }],
    ['длиной в годы', { from: '2020-01-01', to: '2026-09-30' }],
    ['не дата', { from: 'вчера', to: 'сегодня' }],
    ['31 февраля', { from: '2026-02-31', to: '2026-03-01' }],
    ['половина', { from: '2026-09-01' }]
  ])('негодный период (%s) отбрасывается', (_name, period) => {
    expect(decodeLeadsState(JSON.stringify({ period })).period).toBeUndefined()
  })

  it('чужие ключи фильтров не восстанавливаются', () => {
    const state = decodeLeadsState(JSON.stringify({ filters: { sourceId: 'CALL', вредный: 'ключ', assignedById: 'нет' } }))
    expect(state.filters).toEqual({ sourceId: 'CALL' })
  })
})

describe('отчёт по менеджерам', () => {
  it('туда и обратно — то же самое', () => {
    const filters = { categoryId: 2, scope: 'won' as const, period: PERIOD, companyId: 17 }
    expect(decodeManagersState(encodeManagersState(filters))).toEqual(filters)
  })

  // ⚠ Ноль — это «Без моей компании», а не «не задано». Потерять его значит открыть отчёт по
  // всем компаниям там, где человек выбрал сделки без компании.
  it('ноль в компании сохраняется как значение', () => {
    const saved = encodeManagersState({ categoryId: 0, scope: 'in-work', period: PERIOD, companyId: 0 })
    expect(decodeManagersState(saved).companyId).toBe(0)
  })

  it('без компании ключа в настройке нет', () => {
    const saved = encodeManagersState({ categoryId: 0, scope: 'in-work', period: PERIOD })
    expect(JSON.parse(saved)).not.toHaveProperty('companyId')
    expect(decodeManagersState(saved).companyId).toBeUndefined()
  })

  // Направление 0 — «Общее», полноценное значение фильтра, а не «не выбрано».
  it('нулевое направление сохраняется', () => {
    expect(decodeManagersState(JSON.stringify({ categoryId: 0 })).categoryId).toBe(0)
  })

  it('незнакомый охват отбрасывается', () => {
    expect(decodeManagersState(JSON.stringify({ scope: 'чужой' })).scope).toBeUndefined()
    expect(decodeManagersState(JSON.stringify({ scope: 'lost' })).scope).toBe('lost')
  })

  it('мусор в настройке — открываемся с умолчанием', () => {
    expect(decodeManagersState('{')).toEqual({})
    expect(decodeManagersState(null)).toEqual({})
  })
})
