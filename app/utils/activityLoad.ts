import {
  type ActivityReport,
  type ActivityRow,
  type ActivityTotals,
  type ActivityUser,
  type B24CallRow,
  type CallDirection,
  type CallStats,
  type CallTally,
  type DeedCounts,
  type DeedKind,
  type DepartmentRef,
  type LeadCounts,
  CALL_SUCCESS_CODE,
  DEFAULT_CALL_THRESHOLD_SECONDS
} from '~/types/activity'

/**
 * Ядро отчёта «Активность пользователей»: записи телефонии и счётчики портала → таблица по
 * сотрудникам.
 *
 * Чистые функции: ни сети, ни SDK, ни `Date.now()`. Всё, что отчёт показывает, считается здесь и
 * потому проверяется тестом — в шаблоне не должно остаться ни одной формулы.
 *
 * ⚠ Данные приходят ДВУМЯ РАЗНЫМИ способами, и это видно в устройстве модуля. Дела и лиды —
 * счётчиками (`total` по фильтру, пакет из 50 вопросов ≈ 0,4 с), звонки — СТРОКАМИ, потому что
 * сумму длительности `total` не даёт и агрегирующего метода в разделе телефонии нет вовсе
 * ([`docs/PORTAL.md`](../../docs/PORTAL.md)). Цена — 209 страниц на месяц, поэтому звонки читаются
 * фоном ПОСЛЕ основной таблицы, и сборка обязана уметь показать её без них.
 */

/** Число портала: он отдаёт их строками, и `'42'` обязано стать `42`, а мусор — нулём. */
function toNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Счётчик из ответа портала: не число, отрицательное или дробное — ноль. */
function count(totals: Record<string, number>, key: string): number {
  const value = totals[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/**
 * Идентификатор строки для звонка, у которого сотрудника нет.
 *
 * ⚠ Такие записи у заказчика есть — звонки на общую линию, которые никто не поднял. Выбросить их
 * значило бы, что сумма столбцов не сходится с итогом, а объяснить расхождение человеку нечем.
 */
export const NO_USER_ID = 0

/** Как подписана строка звонков без сотрудника. */
export const NO_USER_LABEL = 'Без сотрудника'

/**
 * Направление звонка по коду портала.
 *
 * ⛔ `1` — ИСХОДЯЩИЙ, `2` — ВХОДЯЩИЙ, и это не опечатка. Имя фильтра `INCOMING` толкает прочитать
 * наоборот, а документация значения не расшифровывает вовсе. Проверено на живом портале поимённо,
 * на 38 звонках: у связанных дел CRM направление вышло противоположным наивному чтению, и сам
 * справочник направлений тоже спрошен у портала, чтобы вывод не держался на предположении
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

/** Сотрудник без единого звонка. */
export function emptyCallStats(): CallStats {
  return { calls: emptyCalls(), failed: 0, tooShort: 0 }
}

/** Сотрудник без единого дела. */
export function emptyDeeds(): DeedCounts {
  return { email: { in: 0, out: 0 }, meeting: 0, task: 0, overdue: 0 }
}

/** Сотрудник без единого лида. */
export function emptyLeads(): LeadCounts {
  return { created: 0, won: 0, lost: 0 }
}

/**
 * Ключи счётчиков. Их строит и читает ЯДРО; запросы (`activityQuery.ts`) берут их отсюда же,
 * поэтому карте вопросов и карте ответов разъехаться негде — тот же приём, что в отчёте 2.
 *
 * ⚠ Разделитель `|`, а не `:`, по той же причине, что и там: коды портала двоеточие содержат, и
 * ключ должен разбираться однозначно.
 */
export function deedKey(userId: number, kind: DeedKind, direction?: CallDirection): string {
  return direction ? `d|${userId}|${kind}|${direction}` : `d|${userId}|${kind}`
}

/** Счётчик просроченных дел — он один на сотрудника и считается НА КОНЕЦ периода. */
export function overdueKey(userId: number): string {
  return `o|${userId}`
}

/** Счётчик лидов сотрудника. */
export function leadKey(userId: number, outcome: keyof LeadCounts): string {
  return `l|${userId}|${outcome}`
}

/**
 * Записи звонков → счёт по сотрудникам.
 *
 * @param rows сырые записи `voximplant.statistic.get` за период
 * @param options порог разговора; умолчание — правило заказчика
 * @returns счёт по идентификатору сотрудника; `NO_USER_ID` — звонки без сотрудника
 *
 * ⚠ Имён здесь нет намеренно. Подписывает строки сборка (`buildActivityReport`), и она одна: если
 * бы имя выбиралось и тут, и там, один и тот же человек в разных проходах мог бы получить разные
 * подписи — «Сотрудник #7» в звонках и фамилию в делах.
 */
export function aggregateCalls(
  rows: readonly B24CallRow[],
  options: { thresholdSeconds?: number } = {}
): Map<number, CallStats> {
  const thresholdSeconds = options.thresholdSeconds ?? DEFAULT_CALL_THRESHOLD_SECONDS
  const byUser = new Map<number, CallStats>()

  for (const raw of rows) {
    const userId = toNumber(raw.PORTAL_USER_ID)
    let stats = byUser.get(userId)
    if (!stats) {
      stats = emptyCallStats()
      byUser.set(userId, stats)
    }
    // ⚠ «Состоялся ли» проверяется ДО длительности. У недозвона `CALL_DURATION` — ноль, и
    // проверь мы сначала порог, каждый недозвон попал бы в «короткие разговоры»: показатель
    // заказчика «звонил, но не поговорил» слился бы с «поговорил, но недолго».
    if (!callAnswered(raw)) {
      stats.failed++
      continue
    }
    const seconds = toNumber(raw.CALL_DURATION)
    // ⚠ Строго больше, как в прежнем отчёте (`>CALL_DURATION`), а не «не меньше». Разница в одну
    // секунду, но она меняет числа относительно тех, к которым заказчик привык.
    if (seconds <= thresholdSeconds) {
      stats.tooShort++
      continue
    }
    const tally = stats.calls[callDirection(raw)]
    tally.count++
    tally.seconds += seconds
  }

  return byUser
}

/**
 * Звонки, которым место в таблице под этим отбором.
 *
 * ⛔ Телефония читается ПО ВСЕМУ ПОРТАЛУ: у `voximplant.statistic.get` нет фильтра «сотрудники
 * такого-то отдела», а перечислять девяносто идентификаторов в фильтре каждой из двухсот страниц
 * — это другой отчёт. Поэтому отдел применяется здесь, после чтения.
 *
 * ⚠ Без этого фильтр отдела работал бы наполовину: сотрудник соседнего отдела исчезал бы из
 * таблицы как строка со счётчиками и тут же возвращался бы в неё строкой «Сотрудник #7» — со
 * своими звонками, но с прочерками вместо дел. Человек, выбравший «Отдел закупок», видел бы в нём
 * продавцов.
 *
 * ⚠ Звонки БЕЗ сотрудника (`NO_USER_ID`) под выбранным отделом тоже уходят: они ничьи, а значит,
 * ни к какому отделу не относятся. Без отдела — остаются: там они часть картины портала.
 */
export function scopeCallsToUsers(
  calls: ReadonlyMap<number, CallStats>,
  users: readonly ActivityUser[],
  options: { departmentPicked: boolean }
): Map<number, CallStats> {
  if (!options.departmentPicked) return new Map(calls)
  const listed = new Set(users.map(user => user.id))
  return new Map([...calls].filter(([userId]) => listed.has(userId)))
}

/** Что нужно ядру, чтобы собрать таблицу. */
export interface ActivityInput {
  /** Сотрудники отбора — строки таблицы. Отдел уже применён. */
  users: readonly ActivityUser[]
  /** Счётчики портала по ключам `deedKey` / `overdueKey` / `leadKey`. */
  totals: Record<string, number>
  /** Звонки — приходят фоном, поэтому их может ещё не быть. */
  calls?: ReadonlyMap<number, CallStats>
  thresholdSeconds?: number
}

/** Дела сотрудника из счётчиков. */
function deedsOf(totals: Record<string, number>, userId: number): DeedCounts {
  return {
    email: {
      in: count(totals, deedKey(userId, 'email', 'in')),
      out: count(totals, deedKey(userId, 'email', 'out'))
    },
    meeting: count(totals, deedKey(userId, 'meeting')),
    task: count(totals, deedKey(userId, 'task')),
    overdue: count(totals, overdueKey(userId))
  }
}

/** Лиды сотрудника из счётчиков. */
function leadsOf(totals: Record<string, number>, userId: number): LeadCounts {
  return {
    created: count(totals, leadKey(userId, 'created')),
    won: count(totals, leadKey(userId, 'won')),
    lost: count(totals, leadKey(userId, 'lost'))
  }
}

/**
 * Сколько ДЕЙСТВИЙ у строки — то, по чему таблица сортируется.
 *
 * ⚠ Лидов здесь нет: созданный лид — это результат, а не действие сотрудника, и складывать его с
 * письмами значило бы считать разное в одной сумме. Просроченных дел нет по той же причине: это
 * состояние на конец периода, а не работа, сделанная в нём. Недозвоны и короткие разговоры,
 * наоборот, входят: человек снял трубку и набрал номер, даже если разговора не вышло.
 */
export function activityActions(row: ActivityRow): number {
  return row.calls.in.count + row.calls.out.count + row.failed + row.tooShort
    + row.deeds.email.in + row.deeds.email.out + row.deeds.meeting + row.deeds.task
}

/**
 * Счётчики и звонки → таблица отчёта.
 *
 * ⚠ Строки сортируются по числу действий вниз, а не по имени: отчёт открывают, чтобы увидеть, кто
 * работает больше. При равенстве — по имени, иначе порядок прыгал бы между перерисовками при
 * одинаковых числах.
 *
 * ⚠ Порядок ПЕРЕСТРАИВАЕТСЯ, когда доезжают звонки, и это осознанная цена. Держать таблицу в
 * порядке, посчитанном без половины данных, значило бы показывать «кто работает больше» по одним
 * письмам; поэтому экран, пока `callsKnown` ложно, обязан говорить, что звонки ещё читаются.
 */
export function buildActivityReport(input: ActivityInput): ActivityReport {
  const thresholdSeconds = input.thresholdSeconds ?? DEFAULT_CALL_THRESHOLD_SECONDS
  const calls = input.calls
  const rows: ActivityRow[] = []
  const listed = new Set<number>()

  for (const user of input.users) {
    listed.add(user.id)
    rows.push({
      userId: user.id,
      userName: user.name,
      ...(user.dismissed ? { dismissed: true } : {}),
      ...(calls?.get(user.id) ?? emptyCallStats()),
      deeds: deedsOf(input.totals, user.id),
      leads: leadsOf(input.totals, user.id),
      deedsKnown: true
    })
  }

  // ⚠ Звонки приносят сотрудников, которых в списке не было: запись без `PORTAL_USER_ID` и люди
  // вне выбранного отдела. Спрятать их значило бы, что сумма столбца «разговоры» не сходится с
  // итогом; но и напечатать им ноль писем нельзя — счётчиков дел им никто не задавал, и такой
  // ноль читался бы как «не писал» вместо «не спрашивали». Отсюда `deedsKnown: false`.
  for (const [userId, stats] of calls ?? []) {
    if (listed.has(userId)) continue
    rows.push({
      userId,
      // ⚠ Без имени подписываем номером, а не прочерком: по номеру человека в портале найдут, а
      // прочерк не говорит ничего. Тот же приём, что в отчёте по менеджерам.
      userName: userId === NO_USER_ID ? NO_USER_LABEL : `Сотрудник #${userId}`,
      ...stats,
      deeds: emptyDeeds(),
      leads: emptyLeads(),
      deedsKnown: false
    })
  }

  rows.sort((a, b) => {
    const byActions = activityActions(b) - activityActions(a)
    return byActions !== 0 ? byActions : a.userName.localeCompare(b.userName, 'ru')
  })

  return { rows, totals: activityTotals(rows), thresholdSeconds, callsKnown: calls !== undefined }
}

/**
 * Итоги таблицы.
 *
 * ⚠ Считаются ЗДЕСЬ, а не в шаблоне. Число, посчитанное в разметке, не покрыто тестом и
 * расходится со строками ровно тогда, когда этого никто не ждёт, — правило проекта.
 *
 * ⚠ Итог дел — это итог ПО ОПРОШЕННЫМ сотрудникам: у строк с `deedsKnown: false` дел не спрашивали
 * вовсе, и там стоят нули-заглушки. Складывать их безопасно, но полнотой это не становится.
 */
export function activityTotals(rows: readonly ActivityRow[]): ActivityTotals {
  const totals: ActivityTotals = {
    ...emptyCallStats(),
    deeds: emptyDeeds(),
    leads: emptyLeads(),
    users: 0
  }
  for (const row of rows) {
    for (const direction of ['in', 'out'] as const) {
      totals.calls[direction].count += row.calls[direction].count
      totals.calls[direction].seconds += row.calls[direction].seconds
      totals.deeds.email[direction] += row.deeds.email[direction]
    }
    totals.failed += row.failed
    totals.tooShort += row.tooShort
    totals.deeds.meeting += row.deeds.meeting
    totals.deeds.task += row.deeds.task
    totals.deeds.overdue += row.deeds.overdue
    totals.leads.created += row.leads.created
    totals.leads.won += row.leads.won
    totals.leads.lost += row.leads.lost
    if (activityActions(row) > 0) totals.users++
  }
  return totals
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
export function totalCalls(row: CallStats): CallTally {
  return {
    count: row.calls.in.count + row.calls.out.count,
    seconds: row.calls.in.seconds + row.calls.out.seconds
  }
}

/** Все дела сотрудника за период. Просроченные не в счёт: они не «за период», а «на конец». */
export function totalDeeds(deeds: DeedCounts): number {
  return deeds.email.in + deeds.email.out + deeds.meeting + deeds.task
}

/**
 * Отдел и все отделы под ним.
 *
 * ⛔ Отдел БЕЗ подотделов — почти всегда неверный ответ на «покажи отдел». Замер боевого портала:
 * люди сидят и в листьях, и в узлах — у 10 из 11 узлов есть сотрудники ПРЯМО в них, а не только
 * ниже. Возьми отчёт один узел, и «Департамент распространения» показал бы 37 человек вместо
 * всех, кто в нём работает; возьми он только листья — те же 37 пропали бы. Поэтому берётся
 * поддерево целиком.
 *
 * ⚠ Обход защищён от цикла (`seen`). Дерево приходит от портала, а не строится нами: одна кривая
 * привязка — и наивный обход завис бы, унеся с собой весь отчёт.
 */
export function departmentSubtree(
  departments: readonly DepartmentRef[],
  departmentId: number
): Set<number> {
  const children = new Map<number, number[]>()
  for (const department of departments) {
    if (department.parentId === undefined) continue
    children.set(department.parentId, [...(children.get(department.parentId) ?? []), department.id])
  }
  const seen = new Set<number>()
  const queue = [departmentId]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    queue.push(...(children.get(current) ?? []))
  }
  return seen
}

/**
 * Сотрудники отбора: отдел применяется ЗДЕСЬ, чистой функцией, а не фильтром портала.
 *
 * ⚠ `user.get` фильтр по `UF_DEPARTMENT` понимает, но отчёт всё равно читает сотрудников целиком
 * (оба прохода, работающих и уволенных) и сужает список сам: список нужен ПОЛНЫМ, чтобы наполнить
 * сам выпадающий фильтр отделов, — иначе в нём остались бы только отделы уже выбранного отдела.
 *
 * ⚠ `UF_DEPARTMENT` — МАССИВ: у заказчика 13 сотрудников числятся в нескольких отделах сразу, и
 * попасть человек должен в каждый из них. Сравнение с первым элементом молча теряло бы
 * совместителей.
 */
export function usersInDepartment(
  users: readonly ActivityUser[],
  departments: readonly DepartmentRef[],
  departmentId?: number
): ActivityUser[] {
  if (departmentId === undefined) return [...users]
  const subtree = departmentSubtree(departments, departmentId)
  return users.filter(user => (user.departmentIds ?? []).some(id => subtree.has(id)))
}
