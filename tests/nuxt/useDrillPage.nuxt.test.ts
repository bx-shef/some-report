// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useDrillPage } from '~/composables/useDrillPage'
import type { DrillSliderPayload } from '~/utils/drillSlider'

/**
 * Список записей в настоящем слайдере портала: страницы курсором по `ID`, справочники один раз.
 *
 * ⚠ Этот композабл — единственное место, которое читает записи для слайдера, и он работает с
 * фильтром из НЕПРОВЕРЕННОГО источника (параметры вызова портала). Поэтому главное здесь —
 * инварианты, которые ломаются молча: курсор нельзя перебить чужим ключом фильтра, застрявший
 * курсор обязан закрыть список, а ошибка не должна съедать уже прочитанное.
 */

const portal = vi.hoisted(() => ({
  calls: [] as Array<{ method: string, params: Record<string, unknown> }>,
  /** Ответы списков по порядку: тест сам решает, что вернул портал. */
  pages: [] as Array<unknown[] | Error>,
  /** Пакет справочников упал — подписи пропадают, числа остаются. */
  booksFail: false,
  /** Сколько раз спрашивали справочники: их читают один раз на НАПРАВЛЕНИЕ. */
  books: 0,
  /** Команды последнего пакета справочников: списку лидов стадии сделок не нужны. */
  bookKeys: [] as string[],
  /** Задержка ответа `user.get` — им проверяется, что опоздавшие имена перерисуют строки. */
  usersGate: Promise.resolve() as Promise<void>,
  /** Задержка ответа списка — ею проверяется сторож от гонки при смене условия. */
  gate: Promise.resolve() as Promise<void>
}))

mockNuxtImport('useB24Batch', () => () => ({
  batchResults: async () => ({}),
  batchTotals: async () => ({}),
  batchRowsChecked: async () => ({ rows: {}, complete: true }),
  batchRows: async (commands: Record<string, unknown>) => {
    portal.books++
    portal.bookKeys = Object.keys(commands)
    if (portal.booksFail) throw new Error('пакет не прошёл')
    return {
      sources: [{ STATUS_ID: 'CALL', NAME: 'Звонок' }],
      leadStatuses: [{ STATUS_ID: 'NEW', NAME: 'Не обработан' }],
      dealStages: [{ STATUS_ID: 'C1:NEW', NAME: 'Новая' }]
    }
  }
}))

mockNuxtImport('useB24Users', () => () => ({
  fetchUsers: async () => {
    // Ворота: тест может задержать имена и проверить, что строки перерисуются, когда те придут.
    await portal.usersGate
    return { names: { 7: 'Иванов Иван' }, dismissed: new Set<string>() }
  }
}))

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => true,
  fitWindow: async () => {},
  openPath: async () => true,
  getOrThrow: () => ({
    actions: {
      v2: {
        call: {
          make: async ({ method, params }: { method: string, params: Record<string, unknown> }) => {
            portal.calls.push({ method, params })
            const next = portal.pages.shift()
            // Ворота: тест может задержать ОТВЕТ, оставив запрос в полёте. Только так проверяется
            // сторож от гонки — иначе второй старт успевает раньше, чем первый дойдёт до портала.
            await portal.gate
            if (next instanceof Error) return { isSuccess: false, getData: () => undefined, getErrorMessages: () => [next.message] }
            return { isSuccess: true, getData: () => ({ result: next ?? [] }), getErrorMessages: () => [] }
          }
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.calls = []
  portal.pages = []
  portal.booksFail = false
  portal.books = 0
  portal.bookKeys = []
  portal.usersGate = Promise.resolve()
  portal.gate = Promise.resolve()
})

const PAYLOAD: DrillSliderPayload = {
  entity: 'deal',
  title: 'Сделки: Минск · Иванов',
  filter: { CATEGORY_ID: 1, STAGE_ID: 'C1:NEW' },
  categoryId: 1,
  total: 60
}

/** Страница ответов портала: `count` строк, начиная с `from`. */
function page(count: number, from = 1) {
  return Array.from({ length: count }, (_, index) => ({
    ID: String(from + index),
    TITLE: `Сделка ${from + index}`,
    DATE_CREATE: '2026-09-01T10:00:00+03:00',
    CLOSEDATE: '2026-09-20T10:00:00+03:00',
    STAGE_ID: 'C1:NEW',
    SOURCE_ID: 'CALL',
    ASSIGNED_BY_ID: '7'
  }))
}

describe('useDrillPage', () => {
  it('первая страница читается фильтром нагрузки, строки подписаны словами', async () => {
    portal.pages = [page(3)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    expect(portal.calls[0]?.method).toBe('crm.deal.list')
    expect(drill.rows.value).toHaveLength(3)
    expect(drill.rows.value[0]).toMatchObject({ id: 1, stage: 'Новая', source: 'Звонок', manager: 'Иванов Иван' })
    expect(drill.done.value).toBe(true)
  })

  /**
   * ⚠ Курсор идёт ПОСЛЕ фильтра нагрузки, и это не косметика порядка ключей: пришли бы они
   * наоборот, подделанный `>ID` в фильтре перебил бы наш курсор — и список листался бы по чужому
   * условию, показывая записи, которых за нажатым числом нет.
   */
  it('курсор нельзя перебить ключом из фильтра нагрузки', async () => {
    portal.pages = [page(50), page(2, 51)]
    const drill = useDrillPage()
    await drill.start({ ...PAYLOAD, filter: { ...PAYLOAD.filter, '>ID': 999 } })
    expect((portal.calls[0]?.params.filter as Record<string, unknown>)['>ID']).toBe(0)
    await drill.loadMore()
    expect((portal.calls[1]?.params.filter as Record<string, unknown>)['>ID']).toBe(50)
  })

  it('полная страница оставляет курсор, короткая закрывает список', async () => {
    portal.pages = [page(50), page(7, 51)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    expect(drill.done.value).toBe(false)
    await drill.loadMore()
    expect(drill.rows.value).toHaveLength(57)
    expect(drill.done.value).toBe(true)
  })

  /**
   * ⚠ Курсор не сдвинулся — список закрываем. Иначе «Показать ещё» доклеивало бы ту же страницу
   * без конца, а счётчик «показано M из N» уехал бы мимо N.
   */
  it('застрявший курсор закрывает список, а не крутится вечно', async () => {
    portal.pages = [page(50).map(row => ({ ...row, ID: 'нечисло' })), page(50)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    expect(drill.done.value).toBe(true)
    await drill.loadMore()
    // Второй страницы портал не увидел: список уже закрыт.
    expect(portal.calls).toHaveLength(1)
  })

  it('ошибка страницы показывается и не съедает уже прочитанное', async () => {
    portal.pages = [page(50), new Error('портал устал')]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    await drill.loadMore()
    expect(drill.error.value).toContain('портал устал')
    expect(drill.rows.value).toHaveLength(50)
  })

  // Справочники — удобство подписи, а не данные: их сбой оставляет коды, но не ломает список.
  it('пакет справочников упал — строки остаются, подписаны кодами', async () => {
    portal.booksFail = true
    portal.pages = [page(2)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    expect(drill.rows.value).toHaveLength(2)
    expect(drill.rows.value[0]?.stage).toBe('C1:NEW')
  })

  /**
   * ⚠ Проверяем СЧЁТЧИК СПРАВОЧНИКОВ, а не число запросов списка. Прежняя редакция этого теста
   * считала `crm.deal.list` — то есть страницы, а не справочники; убери кэш совсем, и она
   * осталась бы зелёной. Справочники на каждой странице — это лишний пакет на каждое нажатие
   * «Показать ещё», а при неудаче второго — ещё и две системы подписей в одной таблице.
   */
  it('справочники читаются один раз на весь список, а не на каждую страницу', async () => {
    portal.pages = [page(50), page(1, 51)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    await drill.loadMore()
    expect(portal.calls.filter(call => call.method === 'crm.deal.list')).toHaveLength(2)
    expect(portal.books).toBe(1)
  })

  it('повторный старт сбрасывает строки и курсор', async () => {
    portal.pages = [page(50), page(3)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    await drill.start(PAYLOAD)
    expect(drill.rows.value).toHaveLength(3)
    expect((portal.calls[1]?.params.filter as Record<string, unknown>)['>ID']).toBe(0)
  })

  /**
   * ⚠ Подписи из нагрузки БЬЮТ справочник портала, а не наоборот. За числом в отчёте по лидам
   * стоит каноничное название причины провала, сведённое из стадий четырёх направлений
   * (`reasonMerge.ts`); справочник одного направления назвал бы ту же стадию по-своему, и список
   * разошёлся бы в словах с числом, по которому нажали.
   */
  it('подписи стадий из нагрузки перекрывают справочник портала', async () => {
    portal.pages = [page(1)]
    const drill = useDrillPage()
    await drill.start({ ...PAYLOAD, stageNames: { 'C1:NEW': 'Отказ - Дорого' } })
    expect(drill.rows.value[0]?.stage).toBe('Отказ - Дорого')
  })

  it('подписи из нагрузки остаются словами даже при упавших справочниках', async () => {
    portal.booksFail = true
    portal.pages = [page(1)]
    const drill = useDrillPage()
    await drill.start({ ...PAYLOAD, stageNames: { 'C1:NEW': 'Отказ - Дорого' } })
    expect(drill.rows.value[0]?.stage).toBe('Отказ - Дорого')
  })

  /**
   * ⚠ Справочники помечаются НАПРАВЛЕНИЕМ, а не флажком «читали»: у каждого направления стадии
   * свои (`DEAL_STAGE_<id>`). Пометь мы просто «читали» — повторный старт из другого направления
   * подписал бы стадии чужими словами, и это заметили бы не сразу.
   */
  it('справочники перечитываются при смене направления и не перечитываются при том же', async () => {
    portal.pages = [page(1), page(1), page(1)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    await drill.start(PAYLOAD)
    // Счётчик обнуляем ЗДЕСЬ: сколько пакетов ушло раньше, этому тесту неинтересно, а привязка к
    // накопленному числу делала бы его хрупким к любой правке соседних шагов.
    expect(portal.books).toBe(1)
    portal.books = 0
    await drill.start({ ...PAYLOAD, categoryId: 4 })
    expect(portal.books).toBe(1)
  })

  /**
   * ⚠ Список лидов стадий сделок не касается вовсе: `leadDrillRow` в `dealStages` не заглядывает.
   * Лишняя команда в пакете — ответ, который некуда деть, на каждое открытие слайдера.
   */
  it('списку лидов стадии сделок не запрашиваются', async () => {
    portal.pages = [page(1)]
    const drill = useDrillPage()
    await drill.start({ ...PAYLOAD, entity: 'lead' })
    expect(portal.bookKeys).not.toContain('dealStages')
    expect(portal.bookKeys).toContain('leadStatuses')
  })

  /**
   * ⚠ Имена сотрудников приходят ВТОРЫМ проходом `user.get` по всему порталу и запросто опаздывают
   * за первой страницей. Разложи строки один раз при получении — первая страница осталась бы с
   * «Сотрудник #7», вторая приехала бы с фамилией: один список, две системы подписей.
   */
  it('опоздавшие имена сотрудников перерисовывают УЖЕ показанные строки', async () => {
    let release = (): void => {}
    portal.usersGate = new Promise<void>((resolve) => {
      release = resolve
    })
    portal.pages = [page(1)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    expect(drill.rows.value[0]?.manager).toBe('Сотрудник #7')
    release()
    await portal.usersGate
    await nextTick()
    expect(drill.rows.value[0]?.manager).toBe('Иванов Иван')
  })

  /**
   * ⚠ Сбой справочников НЕ должен уносить с собой имена сотрудников: это разные запросы. Раньше
   * подписка на имена стояла после `await` пакета — ошибка уводила в `catch`, и совершенно
   * исправный список сотрудников пропадал вместе со стадиями.
   */
  it('упавшие справочники не уносят имена сотрудников', async () => {
    portal.booksFail = true
    portal.pages = [page(1)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    await nextTick()
    expect(drill.rows.value[0]?.manager).toBe('Иванов Иван')
    expect(drill.rows.value[0]?.stage).toBe('C1:NEW')
  })

  /**
   * ⚠ Сторож от гонки: повторный старт на неотвеченной странице. Без него ответ ПРОШЛОГО условия
   * доклеился бы к очищенным строкам — записи одного числа под заголовком другого.
   */
  it('ответ сменённого списка выбрасывается', async () => {
    let open = (): void => {}
    portal.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    portal.pages = [page(3), page(2, 100)]
    const drill = useDrillPage()
    const first = drill.start(PAYLOAD)
    // Дожидаемся, что первый запрос УШЁЛ в портал, и только потом меняем условие: иначе первый
    // старт отвалится ещё на справочниках, и гонки, ради которой стоит сторож, не случится вовсе.
    await vi.waitFor(() => expect(portal.calls).toHaveLength(1))
    const second = drill.start({ ...PAYLOAD, title: 'Другое число', filter: { CATEGORY_ID: 2 } })
    await vi.waitFor(() => expect(portal.calls).toHaveLength(2))
    // Оба ответа портал отдаёт только теперь — первый вернётся к уже сменённому условию.
    open()
    await Promise.all([first, second])
    // Строки ТОЛЬКО второго старта: 5 означало бы, что ответ первого доклеился к очищенным.
    expect(drill.rows.value).toHaveLength(2)
    expect(drill.rows.value[0]?.id).toBe(100)
  })

  it('лиды читаются своим методом', async () => {
    portal.pages = [page(1)]
    const drill = useDrillPage()
    await drill.start({ ...PAYLOAD, entity: 'lead' })
    expect(portal.calls[0]?.method).toBe('crm.lead.list')
  })
})

describe('useDrillPage: дела CRM и звонки', () => {
  const ACTIVITY: DrillSliderPayload = {
    entity: 'activity',
    activityScope: 'created',
    title: 'Исходящие письма · Иванов Иван',
    filter: { 'RESPONSIBLE_ID': 7, 'TYPE_ID': 4, 'DIRECTION': 2, '>=CREATED': '2026-08-01' },
    total: 12
  }

  const CALLS: DrillSliderPayload = {
    entity: 'call',
    title: 'Разговоры · Иванов Иван',
    filter: { 'PORTAL_USER_ID': 7, 'CALL_FAILED_CODE': '200', '>CALL_DURATION': 29 },
    total: 60
  }

  it('дела читает crm.activity.list курсором и подписывает видом', async () => {
    portal.pages = [[{
      ID: '5', SUBJECT: 'Счёт', CREATED: '2026-08-03T08:40:08+03:00',
      TYPE_ID: '4', DIRECTION: '2', RESPONSIBLE_ID: '7', OWNER_ID: '900', OWNER_TYPE_ID: '1'
    }]]
    const state = useDrillPage()
    await state.start(ACTIVITY)
    expect(portal.calls[0]?.method).toBe('crm.activity.list')
    const params = portal.calls[0]!.params
    const filter = params.filter as Record<string, unknown>
    expect(filter['>ID']).toBe(0)
    expect(filter.TYPE_ID).toBe(4)
    expect(params.start).toBe(-1)
    expect(state.rows.value[0]?.stage).toBe('Письмо, исходящее')
    expect(state.rows.value[0]?.path).toBe('/crm/lead/details/900/')
  })

  /**
   * ⛔ Главная ловушка этого списка. `voximplant.statistic.get` понимает только ЗАГЛАВНЫЙ `FILTER`:
   * положи ему условие строчным ключом — он не отвергнет запрос, а вернёт ВЕСЬ портал за всё
   * время, и под заголовком «Разговоры: Иванов» откроются чужие звонки за годы.
   */
  it('звонки читает телефонию ЗАГЛАВНЫМ FILTER, а не строчным', async () => {
    portal.pages = [[{ ID: '10', PHONE_NUMBER: '+375291112233', CALL_TYPE: '1', CALL_DURATION: '120', CALL_FAILED_CODE: '200' }]]
    const state = useDrillPage()
    await state.start(CALLS)
    expect(portal.calls[0]?.method).toBe('voximplant.statistic.get')
    const params = portal.calls[0]!.params
    expect(params).toHaveProperty('FILTER')
    expect(params).not.toHaveProperty('filter')
    const filter = params.FILTER as Record<string, unknown>
    expect(filter.PORTAL_USER_ID).toBe(7)
    // Курсор — тот же приём, что у списков CRM: смещение на больших списках даёт дубли.
    expect(filter['>ID']).toBe(0)
    expect(params.SORT).toBe('ID')
    expect(state.rows.value[0]?.title).toBe('+375291112233')
    expect(state.rows.value[0]?.amount).toBe(120)
  })

  /**
   * ⚠ Справочники CRM делам и звонкам не нужны: стадий и источников у них нет. Лишний пакет — это
   * круг по сети перед первой строкой на каждое открытие слайдера.
   */
  it('делам и звонкам справочники CRM не спрашиваются', async () => {
    portal.pages = [[], []]
    const state = useDrillPage()
    await state.start(ACTIVITY)
    expect(portal.books).toBe(0)
    await state.start(CALLS)
    expect(portal.books).toBe(0)
  })

  /** ⚠ Просроченные дела показывают СРОК: число посчитано по нему, а не по дате создания. */
  it('просроченные дела показывают срок, а не дату создания', async () => {
    portal.pages = [[{ ID: '5', TYPE_ID: '3', CREATED: '2023-01-10T10:00:00+03:00', END_TIME: '2026-08-20T10:00:00+03:00' }]]
    const state = useDrillPage()
    await state.start({ ...ACTIVITY, activityScope: 'overdue', title: 'Просроченные дела' })
    expect(state.rows.value[0]?.when).toBe('2026-08-20T10:00:00+03:00')
  })
})
