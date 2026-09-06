import { describe, expect, it } from 'vitest'
import type { ActivityFilters, ActivityRow } from '~/types/activity'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import { activityDrillPayload, hasActivityDrill, isUnassignedRow } from '~/utils/activityDrill'
import { callDrillFilter, deedFilter, leadCountFilter, overdueFilter } from '~/utils/activityQuery'
import { emptyCallStats, emptyDeeds, emptyLeads } from '~/utils/activityLoad'
import { readDrillPayload } from '~/utils/drillSlider'

/**
 * Что стоит за кликабельным числом отчёта «Активность пользователей».
 *
 * ⛔ Главное, что здесь сторожится: условие списка — БУКВАЛЬНО то же, что задавало порталу вопрос
 * «сколько». Не «похожее»: тест сравнивает нагрузку слайдера с результатом той же функции из
 * `activityQuery.ts`. Разойдись они — под числом откроется список другой длины, а заметить это
 * можно только сверкой с CRM вручную.
 */

const period = { from: '2026-08-01', to: '2026-08-31' }

function filters(over: Partial<ActivityFilters> = {}): ActivityFilters {
  return { period, thresholdSeconds: DEFAULT_CALL_THRESHOLD_SECONDS, ...over }
}

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    userId: 7,
    userName: 'Иванов Иван',
    ...emptyCallStats(),
    deeds: emptyDeeds(),
    leads: emptyLeads(),
    deedsKnown: true,
    ...over
  }
}

describe('activityDrillPayload', () => {
  it('условие разговоров — то же, что у счётчика', () => {
    const payload = activityDrillPayload(row(), { kind: 'talks', direction: 'in' }, filters(), 12)
    expect(payload?.entity).toBe('call')
    expect(payload?.filter).toEqual(
      callDrillFilter(period, 'talks', DEFAULT_CALL_THRESHOLD_SECONDS, { userId: 7, direction: 'in' })
    )
    expect(payload?.total).toBe(12)
  })

  it('условие недозвонов и коротких — тоже те же функции', () => {
    expect(activityDrillPayload(row(), { kind: 'failed' }, filters(), 3)?.filter)
      .toEqual(callDrillFilter(period, 'failed', DEFAULT_CALL_THRESHOLD_SECONDS, { userId: 7 }))
    expect(activityDrillPayload(row(), { kind: 'tooShort' }, filters(), 3)?.filter)
      .toEqual(callDrillFilter(period, 'tooShort', DEFAULT_CALL_THRESHOLD_SECONDS, { userId: 7 }))
  })

  it('условие дел и лидов — те же функции, что у счётчиков', () => {
    expect(activityDrillPayload(row(), { kind: 'deed', deed: 'email', direction: 'out' }, filters(), 5)?.filter)
      .toEqual(deedFilter(period, 7, 'email', 'out'))
    expect(activityDrillPayload(row(), { kind: 'deed', deed: 'meeting' }, filters(), 5)?.filter)
      .toEqual(deedFilter(period, 7, 'meeting'))
    expect(activityDrillPayload(row(), { kind: 'overdue' }, filters(), 5)?.filter)
      .toEqual(overdueFilter(period, 7))
    expect(activityDrillPayload(row(), { kind: 'lead', outcome: 'won' }, filters(), 5)?.filter)
      .toEqual(leadCountFilter(period, 7, 'won'))
  })

  /** ⚠ Порог — настройка: список обязан считать тем же порогом, что и число над ним. */
  it('порог отчёта доезжает до условия списка', () => {
    const payload = activityDrillPayload(row(), { kind: 'talks' }, filters({ thresholdSeconds: 60 }), 1)
    expect(payload?.filter['>CALL_DURATION']).toBe(60)
  })

  /**
   * ⚠ Просроченные дела берут в списке СРОК, а не дату создания: число посчитано по сроку и без
   * нижней границы периода. Иначе под ним встали бы даты трёхлетней давности.
   */
  it('просрочка просит список разбирать строки по сроку', () => {
    expect(activityDrillPayload(row(), { kind: 'overdue' }, filters(), 1)?.activityScope).toBe('overdue')
    expect(activityDrillPayload(row(), { kind: 'deed', deed: 'task' }, filters(), 1)?.activityScope).toBe('created')
  })

  /** Заголовок повторяет то, по чему нажали, — иначе список читается как чужой. */
  it('заголовок называет и число, и сотрудника', () => {
    expect(activityDrillPayload(row(), { kind: 'talks', direction: 'out' }, filters(), 1)?.title)
      .toBe('Исходящие разговоры · Иванов Иван')
    expect(activityDrillPayload(row(), { kind: 'lead', outcome: 'lost' }, filters(), 1)?.title)
      .toBe('Проваленные лиды · Иванов Иван')
  })

  /**
   * ⚠ У строки, которой дел не спрашивали, на экране прочерк — списка за ним нет. А звонки у неё
   * настоящие, и они кликабельны.
   */
  it('строке без спрошенных дел даёт список только по звонкам', () => {
    const stranger = row({ deedsKnown: false })
    expect(activityDrillPayload(stranger, { kind: 'talks' }, filters(), 1)).toBeDefined()
    expect(activityDrillPayload(stranger, { kind: 'deed', deed: 'email' }, filters(), 1)).toBeUndefined()
    expect(activityDrillPayload(stranger, { kind: 'overdue' }, filters(), 1)).toBeUndefined()
    expect(activityDrillPayload(stranger, { kind: 'lead', outcome: 'created' }, filters(), 1)).toBeUndefined()
  })

  /**
   * ⚠ `PORTAL_USER_ID: 0` — это ЗНАЧЕНИЕ («звонок без сотрудника»), а не «фильтра нет». Привычное
   * `userId ? …` молча превратило бы строку «Без сотрудника» во «все звонки портала».
   */
  it('строка «Без сотрудника» просит именно свои звонки, а не все', () => {
    const payload = activityDrillPayload(row({ userId: 0, userName: 'Без сотрудника' }), { kind: 'failed' }, filters(), 5)
    expect(payload?.filter.PORTAL_USER_ID).toBe(0)
  })

  /**
   * ⛔ Нагрузка едет через портал и разбирается КАК НЕДОВЕРЕННАЯ, по белому списку полей. Новое
   * условие, забытое в списке, молча не откроет список — этот тест ловит именно такую забывчивость.
   */
  it('каждое собранное условие проходит проверяющий разбор нагрузки', () => {
    const cells = [
      { kind: 'talks' as const },
      { kind: 'talks' as const, direction: 'in' as const },
      { kind: 'failed' as const },
      { kind: 'tooShort' as const },
      { kind: 'deed' as const, deed: 'email' as const, direction: 'out' as const },
      { kind: 'deed' as const, deed: 'meeting' as const },
      { kind: 'deed' as const, deed: 'task' as const },
      { kind: 'overdue' as const },
      { kind: 'lead' as const, outcome: 'created' as const },
      { kind: 'lead' as const, outcome: 'won' as const },
      { kind: 'lead' as const, outcome: 'lost' as const }
    ]
    for (const cell of cells) {
      const payload = activityDrillPayload(row(), cell, filters(), 1)
      expect(payload).toBeDefined()
      const read = readDrillPayload(JSON.stringify({ nonce: 'n1', payload }), 'n1')
      expect(read.ok, `${JSON.stringify(cell)}: ${read.ok ? '' : read.reason}`).toBe(true)
      if (read.ok) expect(read.payload.filter).toEqual(payload!.filter)
    }
  })
})

describe('hasActivityDrill', () => {
  it('за нулём списка нет', () => {
    expect(hasActivityDrill(row(), { kind: 'talks' }, 0)).toBe(false)
    expect(hasActivityDrill(row(), { kind: 'talks' }, 5)).toBe(true)
  })

  it('у строки без спрошенных дел кликабельны только звонки', () => {
    const stranger = row({ deedsKnown: false })
    expect(hasActivityDrill(stranger, { kind: 'talks' }, 5)).toBe(true)
    expect(hasActivityDrill(stranger, { kind: 'deed', deed: 'email' }, 5)).toBe(false)
  })
})

describe('isUnassignedRow', () => {
  it('строка ничьих звонков узнаётся по идентификатору', () => {
    expect(isUnassignedRow(row({ userId: 0 }))).toBe(true)
    expect(isUnassignedRow(row({ userId: 7 }))).toBe(false)
  })
})
