import { describe, expect, it } from 'vitest'
import type { B24CallRow } from '~/types/activity'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import {
  activityTotals,
  aggregateCalls,
  averageCallSeconds,
  callAnswered,
  callDirection,
  totalCalls
} from '~/utils/activityLoad'

/**
 * Ядро отчёта «Активность пользователей».
 *
 * ⚠ Проверяем в первую очередь то, что ломается МОЛЧА: направление звонка (перепутать — поменять
 * местами два столбца, и по числам этого не видно), порог разговора (правило заказчика, сдвиг на
 * секунду меняет все числа) и сходимость итогов со строками.
 */

/** Запись звонка портала: он отдаёт числа СТРОКАМИ, и стенд обязан вести себя так же. */
function call(over: Partial<B24CallRow> = {}): B24CallRow {
  return {
    PORTAL_USER_ID: '7',
    CALL_TYPE: '1',
    CALL_DURATION: '60',
    CALL_FAILED_CODE: '200',
    CALL_START_DATE: '2026-08-04T10:00:00+03:00',
    ...over
  }
}

describe('callDirection', () => {
  /**
   * ⛔ Главная ловушка этого отчёта. `CALL_TYPE: 1` — ИСХОДЯЩИЙ, `2` — ВХОДЯЩИЙ: обратно тому, как
   * читается имя фильтра `INCOMING`, и документация значения не расшифровывает вовсе. Проверено на
   * живом портале через связанные дела CRM (`docs/PORTAL.md`). Перепутай — и два столбца отчёта
   * поменяются местами, а числа останутся правдоподобными.
   */
  it('1 — исходящий, 2 — входящий, а не наоборот', () => {
    expect(callDirection(call({ CALL_TYPE: '1' }))).toBe('out')
    expect(callDirection(call({ CALL_TYPE: '2' }))).toBe('in')
    expect(callDirection(call({ CALL_TYPE: 1 }))).toBe('out')
    expect(callDirection(call({ CALL_TYPE: 2 }))).toBe('in')
  })

  /**
   * ⚠ Неизвестный код — исходящий, а НЕ выброшенная запись. Звонок был; потеряй мы его, итог
   * перестал бы сходиться с суммой столбцов, и объяснить расхождение человеку было бы нечем.
   */
  it.each([['неизвестный код', '9'], ['пусто', undefined], ['мусор', 'abc']])(
    '%s — считаем исходящим, но не выбрасываем', (_name, type) => {
      expect(callDirection(call({ CALL_TYPE: type }))).toBe('out')
    })
})

describe('callAnswered', () => {
  it('состоялся только код 200', () => {
    expect(callAnswered(call({ CALL_FAILED_CODE: '200' }))).toBe(true)
    expect(callAnswered(call({ CALL_FAILED_CODE: 200 }))).toBe(true)
    for (const code of ['304', '603-S', '', undefined]) {
      expect(callAnswered(call({ CALL_FAILED_CODE: code }))).toBe(false)
    }
  })
})

describe('aggregateCalls', () => {
  it('раскладывает разговоры по сотрудникам и направлениям', () => {
    const report = aggregateCalls([
      call({ PORTAL_USER_ID: '7', CALL_TYPE: '2', CALL_DURATION: '100' }),
      call({ PORTAL_USER_ID: '7', CALL_TYPE: '1', CALL_DURATION: '200' }),
      call({ PORTAL_USER_ID: '7', CALL_TYPE: '1', CALL_DURATION: '50' }),
      call({ PORTAL_USER_ID: '9', CALL_TYPE: '2', CALL_DURATION: '80' })
    ], { 7: 'Иванов Иван', 9: 'Петров Пётр' })

    const ivanov = report.rows.find(row => row.userId === 7)!
    expect(ivanov.userName).toBe('Иванов Иван')
    expect(ivanov.calls.in).toEqual({ count: 1, seconds: 100 })
    expect(ivanov.calls.out).toEqual({ count: 2, seconds: 250 })
    expect(report.rows.find(row => row.userId === 9)?.calls.in).toEqual({ count: 1, seconds: 80 })
  })

  /**
   * ⚠ Порог — правило ЗАКАЗЧИКА, и сравнение СТРОГОЕ: прежний отчёт фильтровал `>CALL_DURATION`.
   * Разница в одну секунду, но она сдвигает все числа относительно тех, к которым он привык.
   */
  it('порог строгий: ровно порог — уже не разговор', () => {
    const report = aggregateCalls([
      call({ CALL_DURATION: '29' }),
      call({ CALL_DURATION: '30' })
    ])
    expect(report.rows[0]?.calls.out.count).toBe(1)
    expect(report.rows[0]?.calls.out.seconds).toBe(30)
    expect(report.rows[0]?.tooShort).toBe(1)
    expect(report.thresholdSeconds).toBe(DEFAULT_CALL_THRESHOLD_SECONDS)
  })

  // Порог — настройка отчёта (решение владельца 2026-09-06), а не константа в коде.
  it('порог можно задать, и отчёт называет тот, которым считал', () => {
    const rows = [call({ CALL_DURATION: '10' }), call({ CALL_DURATION: '40' })]
    expect(aggregateCalls(rows, {}, { thresholdSeconds: 0 }).totals.calls.out.count).toBe(2)
    expect(aggregateCalls(rows, {}, { thresholdSeconds: 100 }).totals.calls.out.count).toBe(0)
    expect(aggregateCalls(rows, {}, { thresholdSeconds: 5 }).thresholdSeconds).toBe(5)
  })

  /**
   * ⚠ Недозвон и короткий разговор — РАЗНЫЕ показатели, и ни один не входит в длительность.
   * «Звонил, но не поговорил» у заказчика значит не то же, что «не звонил».
   */
  it('недозвон и короткий разговор считаются отдельно и не идут в длительность', () => {
    const report = aggregateCalls([
      call({ CALL_FAILED_CODE: '304', CALL_DURATION: '0' }),
      call({ CALL_FAILED_CODE: '603-S', CALL_DURATION: '5' }),
      call({ CALL_DURATION: '3' }),
      call({ CALL_DURATION: '90' })
    ])
    const row = report.rows[0]!
    expect(row.failed).toBe(2)
    expect(row.tooShort).toBe(1)
    expect(row.calls.out).toEqual({ count: 1, seconds: 90 })
  })

  /**
   * ⚠ Недозвон длиннее порога всё равно недозвон: сначала код завершения, потом длительность.
   * У портала попадаются записи с ненулевой длительностью и кодом отказа.
   */
  it('код завершения важнее длительности', () => {
    const report = aggregateCalls([call({ CALL_FAILED_CODE: '486', CALL_DURATION: '600' })])
    expect(report.rows[0]?.failed).toBe(1)
    expect(report.totals.calls.out.seconds).toBe(0)
  })

  /**
   * ⚠ Звонок без сотрудника НЕ выбрасывается. Спрятать его — значит получить итог, не сходящийся
   * с суммой строк, и не иметь объяснения. У заказчика такие есть: звонки на общую линию.
   */
  it('звонок без сотрудника попадает в свою строку, а не пропадает', () => {
    const report = aggregateCalls([
      call({ PORTAL_USER_ID: '', CALL_DURATION: '60' }),
      call({ PORTAL_USER_ID: '7', CALL_DURATION: '60' })
    ])
    const orphan = report.rows.find(row => row.userId === 0)
    expect(orphan?.userName).toBe('Без сотрудника')
    expect(orphan?.calls.out.count).toBe(1)
    expect(report.totals.calls.out.count).toBe(2)
  })

  // Без имени — номер, а не прочерк: по номеру человека в портале найдут.
  it('сотрудник без имени подписан номером', () => {
    expect(aggregateCalls([call({ PORTAL_USER_ID: '5562' })]).rows[0]?.userName).toBe('Сотрудник #5562')
  })

  /**
   * ⚠ «Уволен» ставится только по признаку портала. Пометить им того, чьё имя мы просто не смогли
   * прочитать, — соврать про человека, а не про число.
   */
  it('пометка «уволен» — только по признаку портала', () => {
    const report = aggregateCalls(
      [call({ PORTAL_USER_ID: '7' }), call({ PORTAL_USER_ID: '9' })],
      { 7: 'Иванов Иван', 9: 'Петров Пётр' },
      { dismissed: new Set(['9']) }
    )
    expect(report.rows.find(row => row.userId === 7)?.dismissed).toBeUndefined()
    expect(report.rows.find(row => row.userId === 9)?.dismissed).toBe(true)
  })

  /**
   * ⚠ Сортировка по числу разговоров: отчёт открывают, чтобы увидеть, кто работает больше. При
   * равенстве — по имени, иначе порядок прыгал бы между перерисовками на одинаковых числах.
   */
  it('строки идут по числу разговоров, при равенстве — по имени', () => {
    const report = aggregateCalls([
      call({ PORTAL_USER_ID: '1' }),
      call({ PORTAL_USER_ID: '2' }), call({ PORTAL_USER_ID: '2' }), call({ PORTAL_USER_ID: '2' }),
      call({ PORTAL_USER_ID: '3' })
    ], { 1: 'Яковлев Ян', 2: 'Петров Пётр', 3: 'Авдеев Антон' })
    expect(report.rows.map(row => row.userName)).toEqual(['Петров Пётр', 'Авдеев Антон', 'Яковлев Ян'])
  })

  it('пустой период — пустая таблица и нулевые итоги, а не поломка', () => {
    const report = aggregateCalls([])
    expect(report.rows).toEqual([])
    expect(report.totals).toEqual({ calls: { in: { count: 0, seconds: 0 }, out: { count: 0, seconds: 0 } }, failed: 0, tooShort: 0, users: 0 })
  })
})

describe('activityTotals', () => {
  /**
   * ⚠ Прямая проверка, а не только через `aggregateCalls`: функция экспортирована, значит её могут
   * позвать и на строках, собранных иначе — например, на отфильтрованных экраном. Косвенное
   * покрытие такой вызов не сторожит.
   */
  it('складывает произвольные строки, а не только собранные ядром', () => {
    const totals = activityTotals([
      { userId: 1, userName: 'А', calls: { in: { count: 2, seconds: 100 }, out: { count: 1, seconds: 40 } }, failed: 3, tooShort: 1 },
      { userId: 2, userName: 'Б', calls: { in: { count: 0, seconds: 0 }, out: { count: 5, seconds: 500 } }, failed: 0, tooShort: 2 },
      { userId: 3, userName: 'В', calls: { in: { count: 0, seconds: 0 }, out: { count: 0, seconds: 0 } }, failed: 7, tooShort: 0 }
    ])
    expect(totals.calls.in).toEqual({ count: 2, seconds: 100 })
    expect(totals.calls.out).toEqual({ count: 6, seconds: 540 })
    expect(totals.failed).toBe(10)
    expect(totals.tooShort).toBe(3)
    // Третий сотрудник только недозванивался — в счёт «наговоривших» он не идёт.
    expect(totals.users).toBe(2)
  })

  /**
   * ⚠ Итог обязан сходиться с суммой строк — это и есть смысл того, что он считается ядром, а не
   * в шаблоне. Разошлись бы они ровно тогда, когда этого никто не ждёт.
   */
  it('итог сходится с суммой строк', () => {
    const report = aggregateCalls([
      call({ PORTAL_USER_ID: '7', CALL_TYPE: '2', CALL_DURATION: '100' }),
      call({ PORTAL_USER_ID: '9', CALL_TYPE: '2', CALL_DURATION: '50' }),
      call({ PORTAL_USER_ID: '9', CALL_TYPE: '1', CALL_DURATION: '70' }),
      call({ PORTAL_USER_ID: '9', CALL_FAILED_CODE: '304' })
    ])
    const sum = (pick: (row: typeof report.rows[number]) => number) => report.rows.reduce((acc, row) => acc + pick(row), 0)
    expect(report.totals.calls.in.count).toBe(sum(row => row.calls.in.count))
    expect(report.totals.calls.in.seconds).toBe(sum(row => row.calls.in.seconds))
    expect(report.totals.calls.out.count).toBe(sum(row => row.calls.out.count))
    expect(report.totals.failed).toBe(sum(row => row.failed))
    expect(report.totals.calls.in.seconds).toBe(150)
  })

  // «Сотрудников со звонками» — те, у кого есть РАЗГОВОРЫ. Один недозвон работой не считается.
  it('в счёт сотрудников идут только те, кто наговорил', () => {
    const report = aggregateCalls([
      call({ PORTAL_USER_ID: '7', CALL_DURATION: '60' }),
      call({ PORTAL_USER_ID: '9', CALL_FAILED_CODE: '304' })
    ])
    expect(report.totals.users).toBe(1)
  })
})

describe('averageCallSeconds', () => {
  it('среднее по разговорам', () => {
    expect(averageCallSeconds({ count: 4, seconds: 200 })).toBe(50)
  })

  /**
   * ⚠ Без разговоров — `undefined`, а НЕ ноль. Ноль читался бы как «говорили нисколько», а деление
   * на ноль напечатало бы «NaN», после чего отчёт перестают читать целиком.
   */
  it('без разговоров среднего нет', () => {
    expect(averageCallSeconds({ count: 0, seconds: 0 })).toBeUndefined()
  })
})

describe('totalCalls', () => {
  it('складывает оба направления', () => {
    const report = aggregateCalls([
      call({ CALL_TYPE: '1', CALL_DURATION: '100' }),
      call({ CALL_TYPE: '2', CALL_DURATION: '50' })
    ])
    expect(totalCalls(report.rows[0]!)).toEqual({ count: 2, seconds: 150 })
  })
})
