import type {
  ActivityFilters,
  ActivityReport,
  ActivityUser,
  B24CallRow,
  CallStats,
  DepartmentRef
} from '~/types/activity'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import { adaptDepartments, type B24DepartmentRow } from '~/utils/activityAdapter'
import {
  aggregateCalls,
  buildActivityReport,
  scopeCallsToUsers,
  usersInDepartment
} from '~/utils/activityLoad'
import { activityCounterBatch, callListParams } from '~/utils/activityQuery'
import { MOCK_ACTIVITY_USERS, MOCK_DEPARTMENTS, buildMockActivityReport } from '~/utils/mockActivity'
import { resolvePreset } from '~/utils/period'

/**
 * Источник данных отчёта «Активность пользователей».
 *
 * Слои те же, что в остальных отчётах: `activityQuery.ts` знает, что спросить, `activityLoad.ts` —
 * как посчитать, здесь только склейка, состояния загрузки и защита от гонки ответов.
 *
 * Порядок выборки — ДВА этапа, и это главное про устройство:
 *
 * 1. **Быстрый.** Сотрудники (`user.get`, оба прохода), отделы (`department.get`) и счётчики дел и
 *    лидов пакетами по 50. Замер боевого портала: 0,38 с на пакет, 736 команд на 92 сотрудника —
 *    около шести секунд, и таблица уже на экране.
 * 2. **Фоновый.** Звонки — СТРОКАМИ, потому что сумму длительности `total` не даёт вовсе. Месяц
 *    заказчика — 381 страница; пакет их не ускоряет (портал выполняет команды
 *    пакета последовательно), ускоряет только параллельность запросов: восемь разом дают
 *    выигрыш вчетверо: замер 2026-09-06 — 370 мс на страницу, ≈ 2,4 минуты на месяц
 *    ([`docs/PORTAL.md`](../../docs/PORTAL.md)).
 *
 * ⚠ Поэтому таблица обязана показываться БЕЗ звонков, а `report.callsKnown` — говорить экрану, что
 * нули в их столбцах означают «ещё читаем», а не «не звонил».
 *
 * ⚠ Вне портала остаётся демонстрационный набор, и `isDemo` обязан это показывать: отчёт, молча
 * выдающий чужие числа за данные клиента, хуже отсутствующего отчёта.
 */

/**
 * Сколько страниц звонков читаем разом.
 *
 * ⚠ Восемь — это замер, а не круглое число: 8 страниц подряд заняли 26,9 с, по 4 разом — 8,8 с,
 * по 8 разом — 6,8 с. Дальше портал упирается в предел интенсивности запросов, и выигрыш
 * оборачивается ответом «слишком часто» посреди выборки.
 */
export const CALL_CONCURRENCY = 8

/** Записей на странице телефонии. Портал отдаёт ровно столько и `limit` игнорирует. */
export const CALL_PAGE_SIZE = 50

/** Отделов на странице `department.get`. Размер задан порталом и не настраивается. */
export const DEPARTMENT_PAGE_SIZE = 50

/**
 * Предел страниц отделов — предохранитель от бесконечного чтения.
 *
 * ⚠ У заказчика 43 отдела, то есть одна страница. Предел стоит на случай портала, где страниц
 * много: читать их без конца хуже, чем прочитать пятьсот отделов и остановиться.
 */
export const DEPARTMENT_MAX_PAGES = 10

/**
 * Предел страниц звонков — предохранитель, а не ожидаемое число.
 *
 * ⚠ Месяц заказчика — 381 страница, около двух с половиной минут. Квартал — больше тысячи, то
 * есть минут семь чтения;
 * упёршись в предел, отчёт не молчит, а ГОВОРИТ, что звонки посчитаны не все, — молча показанная
 * половина хуже честного «здесь не всё».
 */
export const CALL_MAX_PAGES = 600

/**
 * Умолчание отбора: текущий месяц, все отделы, порог заказчика.
 *
 * ⚠ Функция, а не константа: период считается от «сегодня», и константа, вычисленная при загрузке
 * модуля, показывала бы прошлый месяц у вкладки, открытой через полночь первого числа.
 */
export function defaultActivityFilters(today: Date): ActivityFilters {
  return {
    // `this-month` есть в списке всегда; `?? ` — только чтобы тип не был необязательным.
    period: resolvePreset('this-month', today) ?? { from: '', to: '' },
    thresholdSeconds: DEFAULT_CALL_THRESHOLD_SECONDS
  }
}

/**
 * @param options.today «Сегодня» — от него считаются умолчание периода и даты демо-набора.
 *   Приходит снаружи, чтобы тесты задавали день и получали те же числа.
 */
export function useActivityReport(options: { today?: Date } = {}) {
  const today = options.today ?? new Date()
  const b24 = useB24()
  const { batchTotals } = useB24Batch()
  const { fetchUsers } = useB24Users()

  const source = ref<'mock' | 'portal'>('mock')
  const isDemo = computed(() => source.value === 'mock')
  const report = ref<ActivityReport>(buildActivityReport({ users: [], totals: {} }))
  /** Отделы портала — дерево для фильтра. До первой выборки пуст. */
  const departments = ref<DepartmentRef[]>([])
  /** Отбор, под которым посчитаны числа на экране, — не тот, что выбран в панели. */
  const filters = ref<ActivityFilters>(defaultActivityFilters(today))
  const pending = ref(false)
  /** Звонки читаются фоном: таблица уже на экране, а этот признак держит подпись «читаем звонки». */
  const callsPending = ref(false)
  const error = ref<string | undefined>(undefined)
  /** Ошибка ЗВОНКОВ отдельно от ошибки отчёта: дела и лиды при этом посчитаны и верны. */
  const callsError = ref<string | undefined>(undefined)
  /** Звонков больше, чем отчёт согласен прочитать: показанные числа — не все. */
  const callsTruncated = ref(false)
  /**
   * Отдел выбран, а справочник отделов не прочитался.
   *
   * ⚠ Отдельный признак, потому что последствие тихое: без дерева поддерево отдела схлопывается в
   * один узел, и люди из подотделов исчезают из таблицы при совершенно исправных числах.
   */
  const departmentsIncomplete = ref(false)
  /** Что делаем прямо сейчас — выборка идёт секунды, и молчать всё это время нельзя. */
  const step = ref<string | undefined>(undefined)
  /** Сколько страниц звонков уже прочитано — единственный честный признак движения фона. */
  const callPagesRead = ref(0)

  /**
   * Номер последней запрошенной выборки: отбор переключают кликами, а ответы приходят не в том
   * порядке, в каком их спросили. Медленный ответ прошлого отбора, придя последним, положил бы на
   * экран числа одного периода под подписью другого.
   *
   * ⚠ Тот же номер сторожит и ФОНОВОЕ чтение звонков: оно живёт минуты и переживает две-три
   * смены отбора. Без сторожа звонки августа доехали бы в сентябрьскую таблицу.
   */
  let seq = 0

  /** Сотрудники и их отделы, под которыми собрана таблица, — нужны фону, чтобы пересобрать её. */
  let assembled: { users: ActivityUser[], totals: Record<string, number>, departmentPicked: boolean } | undefined

  /**
   * Сырые записи звонков ПЕРИОДА — как их отдал портал, без применённых порога и отдела.
   *
   * ⛔ Ради этого кэша всё и затевалось: порог и отдел применяет ЯДРО, а не портал
   * (`callListParams` фильтрует только по периоду — иначе недозвоны и короткие считать было бы не
   * из чего). Значит при смене порога или отдела перечитывать портал НЕЧЕГО: те же строки дадут
   * другие числа. Без кэша человек, решивший посмотреть «а если считать от 9 секунд», получал бы
   * не мгновенный пересчёт, а вторую двухминутную выборку — и порог, объявленный настройкой,
   * оказался бы самой дорогой кнопкой отчёта.
   *
   * ⚠ Ключ — ПЕРИОД, и только он: сменился период — записи другие, кэш недействителен.
   * ⚠ `complete` важен отдельно: оборвавшееся чтение переиспользовать можно (числа те же, что уже
   * на экране), но продолжать надо с портала, а не выдавать неполное за готовое.
   */
  let callCache: { period: string, rows: B24CallRow[], complete: boolean } | undefined

  /** Ключ кэша звонков. Период — единственное, что уезжает в фильтр портала. */
  function callCacheKey(period: ActivityFilters['period']): string {
    return `${period.from}|${period.to}`
  }

  /**
   * Отделы портала. Ошибка — пустой список: фильтр просто не предложит отделов.
   *
   * ⛔ Листаем СМЕЩЕНИЕМ и вручную, а НЕ через `callList`, и это проверено, а не предположено. У
   * `department.get` нет параметра `filter` вовсе: фильтры у него плоские (`ID`, `NAME`, `PARENT`,
   * `UF_HEAD`), а страницы — `start`, по 50. `callList` же дописывает курсор `'>ID'` именно в
   * строчный `filter` — портал такой параметр молча игнорирует. Замер боевого портала: с
   * `filter: {'>ID': 4085}` в ответе приехали 25 отделов с меньшим идентификатором, то есть курсор
   * не применился ВООБЩЕ. На портале с полусотней отделов это значит бесконечное чтение одной и
   * той же первой страницы.
   *
   * ⚠ Признак конца — короткая страница, а не `total`: `getData()` отдаёт `{ result, time }`, и
   * `total` там нет вовсе (тот же урок, что стоил отчёту 229 фамилий).
   */
  async function fetchDepartments(): Promise<DepartmentRef[]> {
    const rows: B24DepartmentRow[] = []
    try {
      for (let page = 0; page < DEPARTMENT_MAX_PAGES; page++) {
        const result = await b24.getOrThrow().actions.v2.call.make<B24DepartmentRow[]>({
          method: 'department.get',
          params: { start: page * DEPARTMENT_PAGE_SIZE }
        })
        if (!result.isSuccess) break
        const payload = result.getData()?.result
        const read = Array.isArray(payload) ? payload as B24DepartmentRow[] : []
        rows.push(...read)
        if (read.length < DEPARTMENT_PAGE_SIZE) break
      }
      return adaptDepartments(rows)
    } catch {
      // Без отделов отчёт считается целиком, закрыт только фильтр: это неудобство, а не ошибка.
      return adaptDepartments(rows)
    }
  }

  /** Одна страница звонков. */
  async function fetchCallPage(period: ActivityFilters['period'], start: number): Promise<B24CallRow[]> {
    const result = await b24.getOrThrow().actions.v2.call.make<B24CallRow[]>({
      method: 'voximplant.statistic.get',
      params: callListParams(period, start)
    })
    if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
    const rows = result.getData()?.result
    return Array.isArray(rows) ? rows as B24CallRow[] : []
  }

  /**
   * Звонки фоном: страницы читаются пачками по `CALL_CONCURRENCY`.
   *
   * ⚠ Таблица пересобирается ПО ХОДУ, после каждой пачки, а не в конце. Полторы минуты пустых
   * столбцов при работающем отчёте человек читает как «сломалось»; растущие числа читаются как
   * «идёт работа». Цена — лишние пересборки чистой функцией, они дешевле одного запроса.
   *
   * ⚠ Сбой ОДНОЙ страницы прекращает чтение, но не выбрасывает уже прочитанное: показать девять
   * десятых звонков, сказав об этом, полезнее, чем не показать ничего.
   */
  async function loadCalls(applied: ActivityFilters, mine: number): Promise<void> {
    const rows: B24CallRow[] = []
    const key = callCacheKey(applied.period)
    callsPending.value = true
    callsError.value = undefined
    callsTruncated.value = false
    callPagesRead.value = 0
    try {
      for (let page = 0; page < CALL_MAX_PAGES; page += CALL_CONCURRENCY) {
        if (mine !== seq) return
        const starts = Array.from(
          { length: Math.min(CALL_CONCURRENCY, CALL_MAX_PAGES - page) },
          (_, index) => (page + index) * CALL_PAGE_SIZE
        )
        const pages = await Promise.all(starts.map(start => fetchCallPage(applied.period, start)))
        if (mine !== seq) return
        for (const rowsOfPage of pages) rows.push(...rowsOfPage)
        callPagesRead.value += pages.length
        // ⚠ Кэш пополняется ПО ХОДУ, а не в конце: смени человек порог на середине чтения —
        // пересчитать будет из чего, и заново портал спрашивать не придётся.
        callCache = { period: key, rows: [...rows], complete: false }
        // ⚠ Пересобираем из ВСЕХ накопленных строк, а не досчитываем: ядро — чистая функция, и
        // складывать её результаты между собой было бы вторым, непроверенным сложением.
        applyCalls(rows, applied, mine)
        // Короткая страница означает, что записи кончились: у портала это конец выборки.
        if (pages.some(one => one.length < CALL_PAGE_SIZE)) {
          callCache = { period: key, rows: [...rows], complete: true }
          return
        }
      }
      // Дошли до предела страниц — значит, звонков больше, чем отчёт читает.
      callsTruncated.value = true
    } catch (e) {
      if (mine === seq) callsError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (mine === seq) callsPending.value = false
    }
  }

  /** Пересобрать таблицу с тем, что уже прочитано из телефонии. */
  function applyCalls(rows: readonly B24CallRow[], applied: ActivityFilters, mine: number): void {
    if (mine !== seq || !assembled) return
    const calls: ReadonlyMap<number, CallStats> = scopeCallsToUsers(
      aggregateCalls(rows, { thresholdSeconds: applied.thresholdSeconds }),
      assembled.users,
      { departmentPicked: assembled.departmentPicked }
    )
    report.value = buildActivityReport({
      users: assembled.users,
      totals: assembled.totals,
      calls,
      thresholdSeconds: applied.thresholdSeconds
    })
  }

  /**
   * Забрать данные портала под отбором и пересчитать таблицу.
   *
   * Вне фрейма — тихо остаёмся на демонстрационном наборе: это штатный режим страницы, открытой по
   * прямой ссылке, а не ошибка.
   */
  async function load(next: ActivityFilters = defaultActivityFilters(today)): Promise<void> {
    await b24.init()
    if (!b24.isInit()) {
      // ⚠ Номер двигаем и здесь: фоновое чтение звонков прошлой, портальной выборки может идти
      // прямо сейчас, и без этого оно дописало бы живые звонки в демо-таблицу.
      seq++
      callsPending.value = false
      departments.value = MOCK_DEPARTMENTS
      const users = usersInDepartment(MOCK_ACTIVITY_USERS, MOCK_DEPARTMENTS, next.departmentId)
      report.value = buildMockActivityReport(users, next.period, next.thresholdSeconds, next.departmentId !== undefined)
      filters.value = next
      return
    }

    const mine = ++seq
    const stale = () => mine !== seq
    pending.value = true
    error.value = undefined
    callsError.value = undefined
    callsTruncated.value = false
    departmentsIncomplete.value = false
    try {
      step.value = 'Читаем сотрудников и отделы'
      // Отделы и сотрудники не зависят друг от друга — спрашиваем разом, а не по очереди.
      const [portalUsers, departmentList] = await Promise.all([fetchUsers(), fetchDepartments()])
      if (stale()) return
      if (departmentList.length) departments.value = departmentList
      // ⚠ Считаем по тому справочнику, что реально ЕСТЬ, а не по свежему ответу. `department.get`
      // мог упереться в лимит запросов и вернуть пустоту: тогда `departmentSubtree` свелось бы к
      // одному узлу, сотрудники подотделов молча пропали бы из таблицы, а подпись под панелью
      // продолжала бы называть выбранный отдел. Прошлый справочник тем временем лежит рядом и
      // верен — отделы за минуту не меняются.
      const knownDepartments = departmentList.length ? departmentList : departments.value
      // ⚠ Отдел выбран, а дерева нет вовсе — это НЕ «показать всех»: под подписью «Отдел закупок»
      // человек увидел бы весь портал. Отчёт в таком случае говорит, что справочник не прочитался.
      departmentsIncomplete.value = next.departmentId !== undefined && knownDepartments.length === 0

      const everyone: ActivityUser[] = Object.entries(portalUsers.names).map(([id, name]) => ({
        id: Number(id),
        name,
        ...(portalUsers.dismissed.has(id) ? { dismissed: true } : {}),
        ...(portalUsers.departments[id] ? { departmentIds: portalUsers.departments[id] } : {})
      }))
      // ⚠ Сужаем ПОСЛЕ чтения, а не фильтром портала: полный список нужен, чтобы фильтр отделов
      // предлагал все отделы, а не только те, что внутри уже выбранного.
      const users = usersInDepartment(everyone, knownDepartments, next.departmentId)

      step.value = `Считаем дела и лиды: ${users.length} сотрудников`
      const totals = await batchTotals(activityCounterBatch(users, next))
      if (stale()) return

      assembled = { users, totals, departmentPicked: next.departmentId !== undefined }
      report.value = buildActivityReport({
        users,
        totals,
        thresholdSeconds: next.thresholdSeconds
      })
      filters.value = next
      source.value = 'portal'
      pending.value = false
      step.value = undefined

      // ⛔ Звонки перечитываем ТОЛЬКО при смене периода. Порог и отдел применяет ядро поверх уже
      // прочитанных строк, и портал на них не влияет вовсе: те же записи дадут другие числа
      // мгновенно. Без этого смена порога стоила бы второй двухминутной выборки — ровно та
      // цена, ради ухода от которой порог и делали настройкой.
      const cached = callCache?.period === callCacheKey(next.period) ? callCache : undefined
      if (cached) {
        applyCalls(cached.rows, next, mine)
        // Прочитано было не всё — дочитываем с портала, но уже показывая то, что есть.
        if (!cached.complete) void loadCalls(next, mine)
        return
      }

      // ⚠ Звонки НЕ ждём: таблица уже на экране, а они идут около трёх минут. `void` здесь
      // намеренно — `load()` завершается вместе с быстрым этапом, иначе страница показывала бы
      // «считаем» всё время фонового чтения.
      void loadCalls(next, mine)
    } catch (e) {
      if (!stale()) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      // ⚠ Гасим индикатор только за СВОЙ запрос: иначе устаревший ответ снял бы «считаем» с ещё
      // идущей выборки, и экран замер бы со старыми числами без единого признака работы.
      if (!stale()) {
        pending.value = false
        step.value = undefined
      }
    }
  }

  return {
    report,
    departments,
    filters,
    pending,
    callsPending,
    callPagesRead,
    callsTruncated,
    departmentsIncomplete,
    step,
    error,
    callsError,
    isDemo,
    source,
    load
  }
}
