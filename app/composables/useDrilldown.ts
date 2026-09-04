import type { Ref } from 'vue'
import type { ReportDataset, ReportFilters } from '~/types/report'
import {
  type B24DrillDealRow,
  type B24DrillLeadRow,
  type DrillListParams,
  type DrillRequest,
  type DrillRow,
  dealDrillRow,
  demoDrillRows,
  drillListParams,
  leadDrillRow
} from '~/utils/drilldown'
import { chunkIds } from '~/utils/filters'

/** Страница списка — как у списочных методов портала. */
export const DRILL_PAGE_SIZE = 50

/**
 * Детализация по клику: слайдер со списком записей за числом отчёта (решение владельца от
 * 2026-09-04, п. 10). Что за список — `app/utils/drilldown.ts`; здесь — состояние слайдера и
 * листание страницами по курсору `ID`, как в остальных выборках отчёта.
 *
 * ⚠ Под фильтром по менеджеру или стадии лида сделки «тем же фильтром» — по списку ID лидов из
 * набора (`filteredLeadIds`), кусками по 500: курсор идёт внутри куска, кусок исчерпан —
 * следующий. Иначе список разошёлся бы с числом, по которому нажали.
 */
export function useDrilldown(input: { dataset: Ref<ReportDataset>, filters: Ref<ReportFilters>, isDemo: Ref<boolean> }) {
  const b24 = useB24()
  const open = ref(false)
  const request = ref<DrillRequest | undefined>(undefined)
  const rows = ref<DrillRow[]>([])
  const pending = ref(false)
  const error = ref<string | undefined>(undefined)
  /** Все страницы прочитаны (или список демо-набора собран целиком). */
  const done = ref(false)

  /** Номер открытого списка: ответ страницы закрытого или сменённого списка выбрасывается. */
  let seq = 0
  let params: DrillListParams | undefined
  let chunks: number[][] = []
  let chunkIndex = 0
  let afterId = 0

  /** Код стадии провала → каноничный ключ причины: обратная карта к `lossReasonCodes`. */
  function keyByCode(): Record<string, string> {
    const out: Record<string, string> = Object.create(null)
    for (const [key, codes] of Object.entries(input.dataset.value.dictionaries.lossReasonCodes ?? {})) {
      for (const code of codes) out[code] = key
    }
    return out
  }

  /** Открыть список за числом. Демо-набор — целиком из строк; портал — первая страница сразу. */
  function show(next: DrillRequest): void {
    const mine = ++seq
    request.value = next
    rows.value = []
    error.value = undefined
    done.value = false
    // Страница закрытого списка ещё могла идти: её «читаем…» не наш, иначе новая первая
    // страница не стартовала бы никогда (сторож от двух страниц с одним курсором).
    pending.value = false
    open.value = true
    if (input.isDemo.value) {
      rows.value = demoDrillRows(next, input.dataset.value, input.filters.value)
      done.value = true
      return
    }
    const { dataset, filters } = input
    params = drillListParams(next, dataset.value.period, filters.value, dataset.value.dictionaries.lossReasonCodes ?? {})
    chunks = params.byLeadIds ? chunkIds(dataset.value.filteredLeadIds ?? []) : []
    chunkIndex = 0
    afterId = 0
    // Лидов под фильтром нет — сделок нет, и портал об этом не спрашивают (`LEAD_ID: [0]` отдал бы чужие).
    if (params.byLeadIds && !chunks.length) {
      done.value = true
      return
    }
    void loadMore(mine)
  }

  /** Следующая страница. Повторный вызов, пока идёт страница, — ничего: иначе две страницы с одним курсором. */
  async function loadMore(mine = seq): Promise<void> {
    if (!params || !request.value || pending.value || done.value || mine !== seq) return
    pending.value = true
    const current = request.value
    try {
      const filter = {
        ...params.filter,
        ...(params.byLeadIds ? { LEAD_ID: chunks[chunkIndex] } : {}),
        '>ID': afterId
      }
      const result = await b24.getOrThrow().actions.v2.call.make<unknown[]>({
        method: params.method,
        params: { select: params.select, filter, order: { ID: 'ASC' }, start: -1 }
      })
      if (mine !== seq) return
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      const data = result.getData()?.result
      const page = (Array.isArray(data) ? data : []) as Array<B24DrillLeadRow | B24DrillDealRow>
      const dictionaries = input.dataset.value.dictionaries
      rows.value = [
        ...rows.value,
        ...page.map(row => current.entity === 'lead'
          ? leadDrillRow(row as B24DrillLeadRow, dictionaries)
          : dealDrillRow(row as B24DrillDealRow, dictionaries, keyByCode(), current.dealScope))
      ]
      const last = Number(page.at(-1)?.ID)
      const exhausted = page.length < DRILL_PAGE_SIZE || !Number.isFinite(last) || last <= afterId
      if (!exhausted) {
        afterId = last
      } else if (params.byLeadIds && chunkIndex < chunks.length - 1) {
        chunkIndex++
        afterId = 0
      } else {
        done.value = true
      }
    } catch (e) {
      if (mine === seq) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (mine === seq) pending.value = false
    }
  }

  // Закрыли — идущая страница больше никому не нужна, а следующая не должна стартовать.
  watch(open, (value) => {
    if (!value) seq++
  })

  /** Открыть карточку записи в слайдере портала. Вне портала (демо) карточек нет. */
  async function openRow(row: DrillRow): Promise<boolean> {
    return b24.openPath(row.path)
  }

  return { open, request, rows, pending, error, done, show, loadMore: () => loadMore(), openRow }
}
