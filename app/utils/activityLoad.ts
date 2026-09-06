import {
  type ActivityReport,
  type ActivityRow,
  type ActivityTotals,
  type B24CallRow,
  type CallDirection,
  type CallTally,
  CALL_SUCCESS_CODE,
  DEFAULT_CALL_THRESHOLD_SECONDS
} from '~/types/activity'

/**
 * Ядро отчёта «Активность пользователей»: сырые записи звонков → таблица по сотрудникам.
 *
 * Чистые функции: ни сети, ни SDK, ни `Date.now()`. Всё, что отчёт показывает, считается здесь и
 * потому проверяется тестом — в шаблоне не должно остаться ни одной формулы.
 *
 * ⚠ Считаем ПО СТРОКАМ, а не счётчиками портала, и это вынужденно: `total` даёт только количество,
 * а владельцу нужна сумма длительности, которой в REST нет ни в каком агрегате
 * ([`docs/PORTAL.md`](../../docs/PORTAL.md), «Длительность разговоров»). Цена решения — чтение
 * страницами, поэтому звонки читаются фоном после основного отчёта.
 */

/** Число портала: он отдаёт их строками, и `'42'` обязано стать `42`, а мусор — нулём. */
function toNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Направление звонка по коду портала.
 *
 * ⛔ `1` — ИСХОДЯЩИЙ, `2` — ВХОДЯЩИЙ, и это не опечатка. Имя фильтра `INCOMING` толкает прочитать
 * наоборот, а документация значения не расшифровывает вовсе. Проверено на живом портале: у
 * связанных дел CRM направление вышло противоположным наивному чтению, и сам справочник
 * направлений тоже спрошен у портала, чтобы вывод не держался на предположении
 * ([`docs/PORTAL.md`](../../docs/PORTAL.md), «Телефония»).
 *
 * ⚠ Неизвестный код считаем ИСХОДЯЩИМ, а не выбрасываем: звонок был, и потерять его из итогов
 * хуже, чем отнести не в тот столбец, — итог перестал бы сходиться с суммой столбцов.
 */
export function callDirection(row: B24CallRow): CallDirection {
  return toNumber(row.CALL_TYPE) === 2 ? 'in' : 'out'
}

/** Состоялся ли разговор: портал помечает это кодом завершения. */
export function callAnswered(row: B24CallRow): boolean {
  return String(row.CALL_FAILED_CODE ?? '') === CALL_SUCCESS_CODE
}

/** Пустой счёт — чтобы сложение начиналось с нуля, а не с `undefined`. */
function emptyTally(): CallTally {
  return { count: 0, seconds: 0 }
}

/** Пустая пара направлений. */
function emptyCalls(): Record<CallDirection, CallTally> {
  return { in: emptyTally(), out: emptyTally() }
}

/**
 * Записи звонков → строки отчёта.
 *
 * @param rows сырые записи `voximplant.statistic.get` за период
 * @param names имена сотрудников по идентификатору (`useB24Users`)
 * @param options порог разговора и признак увольнения
 *
 * ⚠ Звонок без сотрудника (`PORTAL_USER_ID` пуст) НЕ выбрасывается, а идёт в строку с `userId: 0`.
 * Спрятать его значило бы, что сумма столбцов не сходится с итогом, а объяснить расхождение
 * человеку будет нечем. У заказчика такие записи есть: это звонки на общую линию, которые не
 * подняли.
 *
 * ⚠ Строки сортируются по числу разговоров, а не по имени: отчёт открывают, чтобы увидеть, кто
 * работает больше, а не чтобы искать человека по алфавиту. При равенстве — по имени, иначе порядок
 * прыгал бы между перерисовками при одинаковых числах.
 */
export function aggregateCalls(
  rows: readonly B24CallRow[],
  names: Record<string, string> = {},
  options: { thresholdSeconds?: number, dismissed?: ReadonlySet<string> } = {}
): ActivityReport {
  const thresholdSeconds = options.thresholdSeconds ?? DEFAULT_CALL_THRESHOLD_SECONDS
  const byUser = new Map<number, ActivityRow>()

  function rowFor(userId: number): ActivityRow {
    const found = byUser.get(userId)
    if (found) return found
    const key = String(userId)
    const created: ActivityRow = {
      userId,
      // ⚠ Без имени подписываем номером, а не прочерком: по номеру человека в портале найдут, а
      // прочерк не говорит ничего. Тот же приём, что в отчёте по менеджерам.
      userName: names[key] ?? (userId > 0 ? `Сотрудник #${userId}` : 'Без сотрудника'),
      ...(options.dismissed?.has(key) ? { dismissed: true } : {}),
      calls: emptyCalls(),
      failed: 0,
      tooShort: 0
    }
    byUser.set(userId, created)
    return created
  }

  for (const raw of rows) {
    const row = rowFor(toNumber(raw.PORTAL_USER_ID))
    if (!callAnswered(raw)) {
      row.failed++
      continue
    }
    const seconds = toNumber(raw.CALL_DURATION)
    // ⚠ Строго больше, как в прежнем отчёте (`>CALL_DURATION`), а не «не меньше». Разница в одну
    // секунду, но она меняет числа относительно тех, к которым заказчик привык.
    if (seconds <= thresholdSeconds) {
      row.tooShort++
      continue
    }
    const tally = row.calls[callDirection(raw)]
    tally.count++
    tally.seconds += seconds
  }

  const list = [...byUser.values()].sort((a, b) => {
    const byCalls = (b.calls.in.count + b.calls.out.count) - (a.calls.in.count + a.calls.out.count)
    return byCalls !== 0 ? byCalls : a.userName.localeCompare(b.userName, 'ru')
  })

  return { rows: list, totals: activityTotals(list), thresholdSeconds }
}

/**
 * Итоги таблицы.
 *
 * ⚠ Считаются ЗДЕСЬ, а не в шаблоне. Число, посчитанное в разметке, не покрыто тестом и
 * расходится со строками ровно тогда, когда этого никто не ждёт, — правило проекта.
 */
export function activityTotals(rows: readonly ActivityRow[]): ActivityTotals {
  const calls = emptyCalls()
  let failed = 0
  let tooShort = 0
  let users = 0
  for (const row of rows) {
    for (const direction of ['in', 'out'] as const) {
      calls[direction].count += row.calls[direction].count
      calls[direction].seconds += row.calls[direction].seconds
    }
    failed += row.failed
    tooShort += row.tooShort
    if (row.calls.in.count + row.calls.out.count > 0) users++
  }
  return { calls, failed, tooShort, users }
}

/**
 * Средняя длительность разговора в секундах. `0` разговоров — `undefined`, а не ноль.
 *
 * ⚠ Ноль здесь означал бы «разговоры были и длились нисколько», а это неправда. Пустой период —
 * норма отчёта, и делить на ноль нельзя: `x / 0` печатает «NaN», после чего отчёт перестают
 * читать целиком (то же правило, что у `share()` в отчёте по лидам).
 */
export function averageCallSeconds(tally: CallTally): number | undefined {
  return tally.count > 0 ? tally.seconds / tally.count : undefined
}

/** Все разговоры сотрудника — обоих направлений вместе. */
export function totalCalls(row: ActivityRow): CallTally {
  return {
    count: row.calls.in.count + row.calls.out.count,
    seconds: row.calls.in.seconds + row.calls.out.seconds
  }
}
