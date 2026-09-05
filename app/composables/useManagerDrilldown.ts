import type { Ref } from 'vue'
import type { ManagerFilters } from '~/types/managers'
import type { ReportDictionaries } from '~/types/report'
import {
  type B24DrillDealRow,
  type DrillListParams,
  type DrillRequest,
  type DrillRow,
  dealDrillRow,
  plainDealListParams
} from '~/utils/drilldown'
import { DRILL_PAGE_SIZE } from '~/composables/useDrilldown'
import { cellDealFilter } from '~/utils/managerQuery'
import { filterMockDeals, mockManagerDeals, MOCK_STAGES } from '~/utils/mockManagers'

/**
 * Детализация отчёта «Сделки по менеджерам»: список сделок за числом матрицы.
 *
 * ⚠ Композабл свой, а не общий с отчётом по лидам, и это осознанно. Там список строится поверх
 * ПЕРИОДА и фильтров отчёта, а под фильтром по менеджеру ещё и кусками по списку ID лидов; здесь
 * фильтр приходит готовым и целиком (`dealScope: 'plain'`) — компания, менеджер, стадия. Общими
 * остаются то, что и должно быть общим: разбор строки (`dealDrillRow`), состав полей и слайдер.
 * Свести их в один композабл значило бы завести флаг «какой я сегодня отчёт» на каждой ветке.
 */
export function useManagerDrilldown(input: {
  filters: Ref<ManagerFilters>
  dictionaries: Ref<ReportDictionaries>
  isDemo: Ref<boolean>
  /** «Сегодня»: от него построены даты демонстрационного набора, и список обязан их повторить. */
  today: Date
}) {
  const b24 = useB24()
  const open = ref(false)
  const request = ref<DrillRequest | undefined>(undefined)
  const rows = ref<DrillRow[]>([])
  const pending = ref(false)
  const error = ref<string | undefined>(undefined)
  const done = ref(false)

  /** Номер открытого списка: ответ закрытого или сменённого списка выбрасывается. */
  let seq = 0
  let params: DrillListParams | undefined
  let afterId = 0

  /** Список за клеткой матрицы — тем же условием, что дало число. */
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
      rows.value = demoRows(next)
      done.value = true
      return
    }
    params = plainDealListParams(next)
    afterId = 0
    void loadMore(mine)
  }

  /** Следующая страница списка — курсором по `ID`, как и все выборки отчётов. */
  async function loadMore(mine = seq): Promise<void> {
    if (!params || !request.value || pending.value || done.value || mine !== seq) return
    pending.value = true
    // Повторная попытка после ошибки — с чистой плашкой: иначе она висела бы над свежими строками.
    error.value = undefined
    try {
      const dictionaries = input.dictionaries.value
      const result = await b24.getOrThrow().actions.v2.call.make<unknown[]>({
        method: params.method,
        params: { select: params.select, filter: { ...params.filter, '>ID': afterId }, order: { ID: 'ASC' }, start: -1 }
      })
      if (mine !== seq) return
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      const data = result.getData()?.result
      const page = (Array.isArray(data) ? data : []) as B24DrillDealRow[]
      rows.value = [...rows.value, ...page.map(row => dealDrillRow(row, dictionaries, {}, 'plain'))]
      const last = Number(page.at(-1)?.ID)
      if (page.length < DRILL_PAGE_SIZE || !Number.isFinite(last) || last <= afterId) done.value = true
      else afterId = last
    } catch (e) {
      if (mine === seq) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (mine === seq) pending.value = false
    }
  }

  /**
   * Тот же список для демо-набора — по его сделкам, чтобы предпросмотр открывал ровно то число,
   * по которому нажали. Карточек в CRM у демо-строк нет (`path` пуст).
   */
  function demoRows(next: DrillRequest): DrillRow[] {
    const filters = input.filters.value
    const stages = MOCK_STAGES[filters.categoryId] ?? []
    const companyId = next.extra.MYCOMPANY_ID
    const managerId = next.extra.ASSIGNED_BY_ID
    const stageId = next.extra.STAGE_ID
    return filterMockDeals(mockManagerDeals(input.today), filters)
      .filter(deal => (companyId === undefined || String(deal.companyId) === String(companyId))
        && (managerId === undefined || String(deal.managerId) === String(managerId))
        && (stageId === undefined || String(deal.stageId) === String(stageId)))
      .map(deal => ({
        id: deal.id,
        title: deal.title,
        when: deal.createdAt,
        stage: stages.find(stage => stage.id === deal.stageId)?.name ?? deal.stageId,
        manager: input.dictionaries.value.users?.[String(deal.managerId)] ?? `Сотрудник #${deal.managerId}`,
        path: ''
      }))
  }

  // Закрыли — идущая страница больше никому не нужна, следующая не должна стартовать, а
  // прочитанные строки незачем держать в памяти.
  watch(open, (value) => {
    if (value) return
    seq++
    rows.value = []
  })

  /** Открыть карточку сделки в слайдере портала. Вне портала (демо) карточек нет. */
  async function openRow(row: DrillRow): Promise<boolean> {
    if (!row.path) return false
    const opened = await b24.openPath(row.path)
    if (!opened) error.value = 'Портал не открыл карточку — попробуйте ещё раз или откройте её из CRM.'
    return opened
  }

  /** Что показать за числом: заголовок и полный фильтр списка. */
  function cellRequest(
    title: string,
    base: Record<string, unknown>,
    cell: { companyId?: number, managerId?: number, stageId?: string },
    total: number
  ): DrillRequest {
    return {
      entity: 'deal',
      dealScope: 'plain',
      title,
      extra: cellDealFilter(base, cell) as DrillRequest['extra'],
      total
    }
  }

  return { open, request, rows, pending, error, done, show, loadMore: () => loadMore(), openRow, cellRequest }
}
