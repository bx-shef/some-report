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
  books: 0
}))

mockNuxtImport('useB24Batch', () => () => ({
  batchResults: async () => ({}),
  batchTotals: async () => ({}),
  batchRowsChecked: async () => ({ rows: {}, complete: true }),
  batchRows: async () => {
    portal.books++
    if (portal.booksFail) throw new Error('пакет не прошёл')
    return {
      sources: [{ STATUS_ID: 'CALL', NAME: 'Звонок' }],
      leadStatuses: [{ STATUS_ID: 'NEW', NAME: 'Не обработан' }],
      dealStages: [{ STATUS_ID: 'C1:NEW', NAME: 'Новая' }]
    }
  }
}))

mockNuxtImport('useB24Users', () => () => ({
  fetchUsers: async () => ({ names: { 7: 'Иванов Иван' }, dismissed: new Set<string>() })
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
   * ⚠ Стадии берутся у НУЖНОГО направления: у каждого они свои (`DEAL_STAGE_<id>`). Направление
   * приезжает в нагрузке — потеряй его, и список из направления 1 печатал бы коды там, где в
   * таблице над ним написаны слова.
   */
  it('справочники читаются один раз на страницу', async () => {
    portal.pages = [page(50), page(1, 51)]
    const drill = useDrillPage()
    await drill.start(PAYLOAD)
    await drill.loadMore()
    expect(portal.calls.filter(call => call.method === 'crm.deal.list')).toHaveLength(2)
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
    const once = portal.calls.length
    await drill.start(PAYLOAD)
    expect(portal.calls.length - once).toBe(1)
    await drill.start({ ...PAYLOAD, categoryId: 4 })
    expect(portal.books).toBe(2)
  })

  it('лиды читаются своим методом', async () => {
    portal.pages = [page(1)]
    const drill = useDrillPage()
    await drill.start({ ...PAYLOAD, entity: 'lead' })
    expect(portal.calls[0]?.method).toBe('crm.lead.list')
  })
})
