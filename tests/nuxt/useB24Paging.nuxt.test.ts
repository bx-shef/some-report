// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { effectScope } from 'vue'
import { PAGED_MAX_PAGES, useB24Paging } from '~/composables/useB24Paging'
import { LIST_PAGE_SIZE } from '~/utils/b24Query'
import { asPortalWire } from '../helpers/portalWire'

/**
 * Постраничное чтение портала.
 *
 * ⚠ Проверяются здесь не «страницы приезжают» — это видно по тестам самих отчётов, — а ЗАЩИТЫ.
 * Каждая заведена по случаю, где портал отвечает УСПЕШНО, но неполно: такая выборка даёт число
 * меньше настоящего и совершенно правдоподобное, без единого признака поломки. Через полный
 * прогон отчёта их не поймать — там строки приходят из стенда ровно такими, какими их положили.
 */
interface PortalRow { ID: number }

const portal = vi.hoisted(() => ({
  /** Сколько записей портал НАСЧИТАЛ (`getTotal`). Может расходиться со строками — в том и суть. */
  total: 0,
  /** Строк на странице вопреки `total`: так проверяется «страница есть, а счёта нет». */
  rowsPerPage: undefined as number | undefined,
  /** Конверт ответа: списки CRM отдают массив, `crm.stagehistory.list` — `{ items }`. */
  envelope: 'array' as 'array' | 'items',
  /** Ключи команд пакета, ответ по которым портал «потеряет»: ни строк, ни ошибки. */
  dropKeys: [] as string[],
  /** Смещения, по которым портал отдаёт строки ПРЕДЫДУЩЕЙ страницы: окно съехало при записи. */
  repeatStarts: [] as number[],
  /** Что дошло до портала: метод и параметры каждого запроса. */
  calls: [] as Array<{ method: string, params: Record<string, unknown> }>
}))

/** Страница: `count` записей, идентификаторы подряд после `afterId`. */
function rows(afterId: number, count: number): PortalRow[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => ({ ID: afterId + index + 1 }))
}

/** Сколько строк осталось до `total` начиная со смещения, но не больше страницы. */
function left(from: number): number {
  return portal.rowsPerPage ?? Math.min(LIST_PAGE_SIZE, Math.max(0, portal.total - from))
}

/** Строки страницы по СМЕЩЕНИЮ. */
function pageAt(start: number): PortalRow[] {
  const from = portal.repeatStarts.includes(start) ? start - LIST_PAGE_SIZE : start
  return rows(from, left(start))
}

function enveloped(page: PortalRow[]): unknown {
  return portal.envelope === 'items' ? { items: page } : page
}

/** Ответ портала на одиночный запрос — как его отдаёт `AjaxResult`. */
function answer(payload: unknown) {
  return {
    isSuccess: true,
    getData: () => ({ result: payload }),
    getTotal: () => portal.total,
    getErrorMessages: () => [] as string[]
  }
}

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => true,
  getOrThrow: () => ({
    actions: {
      v2: {
        call: {
          make: async ({ method, params }: { method: string, params: Record<string, unknown> }) => {
            // ⚠ Как настоящий портал: запрос уезжает через `postMessage` и клонируется структурно.
            asPortalWire(params)
            portal.calls.push({ method, params })
            const start = Number(params.start)
            // `start: -1` — это свой курсор (`fetchAllUntil`): страница берётся от `>ID`.
            if (start === -1) {
              const after = Number((params.filter as Record<string, unknown>)['>ID'] ?? 0)
              return answer(enveloped(rows(after, left(after))))
            }
            return answer(enveloped(pageAt(start)))
          }
        },
        callList: {
          make: async ({ method, params }: { method: string, params: Record<string, unknown> }) => {
            portal.calls.push({ method, params })
            return { isSuccess: true, getData: () => rows(0, portal.total), getErrorMessages: () => [] as string[] }
          }
        },
        batch: {
          make: async ({ calls }: { calls: Record<string, { method: string, params: Record<string, unknown> }> }) => {
            asPortalWire(calls)
            const data: Record<string, unknown> = {}
            for (const [key, command] of Object.entries(calls)) {
              // Портал «промолчал» по команде: успешный пакет без её ключа — ни строк, ни ошибки.
              if (portal.dropKeys.includes(key)) continue
              const page = pageAt(Number(command.params.start))
              data[key] = { getData: () => ({ result: enveloped(page) }), getTotal: () => portal.total }
            }
            return {
              isSuccess: true,
              getData: () => data,
              getErrorMessages: () => [] as string[],
              getErrorsByKey: () => ({})
            }
          }
        }
      }
    }
  })
}))

/** Композабл живёт в области видимости: `useB24Batch` внутри вешает `onScopeDispose`. */
function paging(): ReturnType<typeof useB24Paging> {
  const scope = effectScope()
  let api!: ReturnType<typeof useB24Paging>
  scope.run(() => {
    api = useB24Paging()
  })
  return api
}

const anyList = { select: ['ID'], filter: {} }

beforeEach(() => {
  portal.total = 0
  portal.rowsPerPage = undefined
  portal.envelope = 'array'
  portal.dropKeys = []
  portal.repeatStarts = []
  portal.calls = []
})

describe('постраничное чтение портала', () => {
  /**
   * ⛔ `getTotal()` прогоняет ответ через `Text.toInteger`, то есть ОТСУТСТВУЮЩИЙ `total`
   * превращается в 0. Без этой проверки `0 <= LIST_PAGE_SIZE` заставило бы выборку вернуть одну
   * страницу из тысячи и объявить это всей выборкой.
   */
  it('страница полная, а счёта нет — это ошибка чтения, а не пустая выборка', async () => {
    const { fetchAllPaged } = paging()
    portal.total = 0
    portal.rowsPerPage = LIST_PAGE_SIZE
    await expect(fetchAllPaged('crm.deal.list', anyList, () => false))
      .rejects.toThrow(/не сосчитал записи/)
  })

  /**
   * ⚠ Предел страниц — не усечение, а тормоз против разгона: испорченный `total` увёл бы отчёт в
   * тысячи запросов и исчерпал лимит интенсивности портала для всех, кто в эту минуту в CRM.
   */
  it('портал насчитал больше страниц, чем отчёт читает за раз, — выборка падает', async () => {
    const { fetchAllPaged } = paging()
    portal.total = (PAGED_MAX_PAGES + 1) * LIST_PAGE_SIZE
    await expect(fetchAllPaged('crm.deal.list', anyList, () => false))
      .rejects.toThrow(/больше, чем отчёт читает за раз/)
  })

  /**
   * ⛔ Пустой ответ по команде — это не отказ: отказ делает неуспешным весь пакет и виден сразу.
   * Здесь портал ответил успешно, просто без одной страницы. Полсотни сделок, не попавших в
   * ВЫРУЧКУ, дают число меньше настоящего и совершенно правдоподобное — тот самый класс дефекта,
   * что стоил отчёту 2 двухсот фамилий.
   */
  it('портал промолчал по одной команде пакета — ошибка, а не строки без неё', async () => {
    const { fetchAllPaged } = paging()
    portal.total = LIST_PAGE_SIZE * 3
    portal.dropKeys = ['p2']
    await expect(fetchAllPaged('crm.deal.list', anyList, () => false))
      .rejects.toThrow(/не ответил на 1 из 2 страниц/)
  })

  /**
   * ⚠ Смещение не переживает запись во время прохода: вставка между страницами сдвигает окно, и
   * строка приезжает дважды. В выручке дубль завышает сумму молча, поэтому строки сводятся по `ID`.
   */
  it('съехавшее окно даёт строку дважды — сведение по ID её убирает', async () => {
    const { fetchAllPaged } = paging()
    portal.total = LIST_PAGE_SIZE * 3
    portal.repeatStarts = [LIST_PAGE_SIZE]
    const got = await fetchAllPaged<PortalRow>('crm.deal.list', anyList, () => false)
    expect(got).toHaveLength(LIST_PAGE_SIZE * 2)
    expect(new Set(got.map(row => row.ID)).size).toBe(got.length)
  })

  /**
   * ⚠ Сюда ходят только методы с плоским массивом. «Непонятный конверт → пустой массив» означало
   * бы выборку, тихо вернувшую ноль строк при исправном портале.
   */
  it('чужой конверт ответа роняет выборку, а не превращается в ноль строк', async () => {
    const { fetchAllPaged } = paging()
    portal.total = LIST_PAGE_SIZE * 2
    portal.envelope = 'items'
    await expect(fetchAllPaged('crm.deal.list', anyList, () => false))
      .rejects.toThrow(/пришёл не списком строк/)
  })

  /**
   * ⚠ А `fetchAllUntil` конверт `{ items }` понимать ОБЯЗАН: так отвечает `crm.stagehistory.list`.
   * Без этой ветки история приходила бы пустой, каждый лид считался бы без ответа, и блок 6
   * показывал бы «просрочено 100 %» под вечным «ждёт историю стадий».
   */
  it('история стадий приезжает конвертом { items } — и всё равно читается', async () => {
    const { fetchAllUntil } = paging()
    portal.total = LIST_PAGE_SIZE * 2
    portal.envelope = 'items'
    const got = await fetchAllUntil<PortalRow>('crm.stagehistory.list', anyList, () => false)
    expect(got).toHaveLength(LIST_PAGE_SIZE * 2)
  })

  /**
   * ⚠ Ради этого `fetchAllUntil` и заведён: `callList` отмены не знает, и каждая смена периода
   * оставляла бы в портале ещё одну многоминутную выборку — а лимит запросов у неё общий с тем
   * отчётом, который человек смотрит сейчас.
   */
  it('устаревшая выборка бросается на ближайшей странице, а не дочитывается до конца', async () => {
    const { fetchAllUntil } = paging()
    portal.total = LIST_PAGE_SIZE * 10
    let asked = 0
    const got = await fetchAllUntil<PortalRow>('crm.lead.list', anyList, () => ++asked > 2)
    expect(portal.calls).toHaveLength(2)
    expect(got).toHaveLength(LIST_PAGE_SIZE * 2)
  })
})
