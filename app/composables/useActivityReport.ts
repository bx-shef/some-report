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
import { activityCounterBatch, callListParams, callPageCommands, callPageOfKey } from '~/utils/activityQuery'
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
 *    заказчика — 381 страница, и читаются они ПАКЕТАМИ по 50 команд: замер 2026-09-06 — 24 мс
 *    на страницу против 124 мс одиночными запросами, весь месяц за 5,7 секунды и восемь
 *    HTTP-запросов ([`docs/PORTAL.md`](../../docs/PORTAL.md)).
 *
 * ⚠ Поэтому таблица обязана показываться БЕЗ звонков, а `report.callsKnown` — говорить экрану, что
 * нули в их столбцах означают «ещё читаем», а не «не звонил».
 *
 * ⚠ Вне портала остаётся демонстрационный набор, и `isDemo` обязан это показывать: отчёт, молча
 * выдающий чужие числа за данные клиента, хуже отсутствующего отчёта.
 */

/**
 * Сколько страниц звонков просим ОДНИМ пакетом.
 *
 * ⛔ Пятьдесят — предел пакета Битрикс24, и пакет здесь ускоряет РАДИКАЛЬНО. Перемер 2026-09-06:
 * восемь одиночных запросов разом дают 124 мс на страницу, один пакет из пятидесяти — 24 мс.
 * Весь август (381 страница) пакетами читается за 5,7 секунды и восемь HTTP-запросов вместо
 * минут и трёхсот восьмидесяти.
 *
 * ⚠ Прежняя редакция читала одиночными запросами по восемь разом, ссылаясь на замер «пакет не
 * ускоряет: портал выполняет команды пакета последовательно». Тот замер был неверен: команды
 * внутри пакета и правда идут одна за другой, но круг по сети экономится на каждой из
 * пятидесяти — вот этого вывод и не учёл.
 */
export const CALL_BATCH_SIZE = 50

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
 * Предел длины периода отчёта — ОДИН МЕСЯЦ (решение владельца 2026-09-06).
 *
 * ⚠ 31 день, а не 30: иначе «текущий месяц» в июле или августе не влезал бы в собственный предел,
 * и кнопка умолчания отвечала бы жалобой.
 *
 * ⛔ Ограничение остаётся, хотя пакетная выборка сделала месяц шестисекундным. Дело не только в
 * ожидании: звонки читаются СТРОКАМИ, и квартал — это под шестьдесят тысяч записей, которые лежат
 * в памяти фрейма и пересчитываются на каждую смену порога. Длинные периоды — разговор про
 * backend ([#52](https://github.com/bx-shef/some-report/issues/52)), а не про терпение.
 */
export const ACTIVITY_MAX_DAYS = 31

/**
 * Предел страниц звонков — предохранитель, а не ожидаемое число.
 *
 * ⚠ Месяц заказчика — 381 страница, пакетами это около шести секунд. Предел стоит вдвое выше: он
 * защищает от портала, где звонков кратно больше, а не от обычной работы. Упёршись в него, отчёт
 * не молчит, а ГОВОРИТ, что звонки посчитаны не все, — молча показанная половина хуже честного
 * «здесь не всё».
 *
 * ⚠ Период отчёта ограничен ОДНИМ МЕСЯЦЕМ (решение владельца 2026-09-06), так что до предела
 * дело доходить не должно вовсе. Убирать его поэтому нельзя: он и есть проверка этого допущения.
 */
export const CALL_MAX_PAGES = 800

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
  const { batchRows, batchTotals } = useB24Batch()
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
   * не мгновенный пересчёт, а вторую полную выборку звонков — и порог, объявленный настройкой,
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

  /**
   * Сколько всего звонков за период — один счётчик.
   *
   * ⚠ `getTotal()`, а не длина `result`: `getData()` отдаёт `{ result, time }`, и `total` там нет
   * вовсе — тот же урок, что стоил отчёту 229 фамилий.
   */
  async function fetchCallTotal(period: ActivityFilters['period']): Promise<number> {
    const result = await b24.getOrThrow().actions.v2.call.make<B24CallRow[]>({
      method: 'voximplant.statistic.get',
      params: callListParams(period)
    })
    if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
    const total = result.getTotal?.()
    return Number.isFinite(total) && total! > 0 ? Math.trunc(total!) : 0
  }

  /**
   * Звонки пакетами: пятьдесят страниц за один круг по сети.
   *
   * ⚠ Таблица пересобирается ПОСЛЕ КАЖДОГО пакета, а не в конце: месяц иначе показывался бы одним
   * прыжком, и человек не видел бы, что идёт работа.
   *
   * ⚠ Сбой пакета прекращает чтение, но не выбрасывает уже прочитанное: показать девять десятых
   * звонков, сказав об этом, полезнее, чем не показать ничего.
   */
  async function loadCalls(applied: ActivityFilters, mine: number): Promise<void> {
    const rows: B24CallRow[] = []
    const key = callCacheKey(applied.period)
    callsPending.value = true
    callsError.value = undefined
    callsTruncated.value = false
    callPagesRead.value = 0
    try {
      // Сколько всего страниц — один счётчик. Без него пришлось бы читать «пока не кончится», то
      // есть тратить лишний круг пакетов на каждом периоде.
      const total = await fetchCallTotal(applied.period)
      if (mine !== seq) return
      const wanted = Math.ceil(total / CALL_PAGE_SIZE)
      const pages = Math.min(wanted, CALL_MAX_PAGES)

      for (let page = 0; page < pages; page += CALL_BATCH_SIZE) {
        if (mine !== seq) return
        const count = Math.min(CALL_BATCH_SIZE, pages - page)
        const answers = await batchRows<B24CallRow>(
          callPageCommands(applied.period, page, count, CALL_PAGE_SIZE)
        )
        if (mine !== seq) return
        // ⚠ Ответы пакета приходят ОБЪЕКТОМ, и порядок ключей в нём не гарантирован. Строки
        // складываем по номеру страницы из ключа: иначе выборка перемешалась бы, а по числам это
        // не видно — ядро всё равно считает по сотрудникам, не по порядку записей.
        const byPage = Object.entries(answers)
          .map(([name, pageRows]) => [callPageOfKey(name), pageRows] as const)
          .filter(([number]) => number >= 0)
          .sort((a, b) => a[0] - b[0])
        for (const [, pageRows] of byPage) rows.push(...pageRows)
        callPagesRead.value += byPage.length
        // ⚠ Кэш пополняется ПО ХОДУ: смени человек порог на середине чтения — пересчитать будет
        // из чего, и заново портал спрашивать не придётся.
        callCache = { period: key, rows: [...rows], complete: false }
        // ⚠ Пересобираем из ВСЕХ накопленных строк, а не досчитываем: ядро — чистая функция, и
        // складывать её результаты между собой было бы вторым, непроверенным сложением.
        applyCalls(rows, applied, mine)
      }

      callCache = { period: key, rows: [...rows], complete: true }
      // Звонков больше, чем отчёт читает за раз, — молчать об этом нельзя.
      if (wanted > CALL_MAX_PAGES) callsTruncated.value = true
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
      // мгновенно. Без этого смена порога стоила бы второй полной выборки звонков — ровно та
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
