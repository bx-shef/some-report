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
}) {
  const b24 = useB24()
  const slider = usePortalSlider()
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

  /**
   * Список за клеткой матрицы — тем же условием, что дало число.
   *
   * ⚠ Открывает его НАСТОЯЩИЙ слайдер портала (решение владельца от 2026-09-06): отдельный фрейм
   * поверх всего портала, а не панель внутри нашего. Условие здесь всегда самодостаточно (охват
   * `plain` — полный фильтр списка), поэтому в параметры слайдера оно помещается целиком.
   *
   * ⚠ Панель внутри отчёта осталась ровно на один случай: слайдер отказал (мобильное приложение).
   * Клик, после которого ничего не произошло, читается как поломка отчёта.
   *
   * ⚠ ВНЕ ПОРТАЛА детализации нет совсем: числа там не кликабельны, и сюда попасть неоткуда.
   */
  function show(next: DrillRequest): void {
    void showAsync(next)
  }

  /**
   * ⚠ Асинхронный: условие уезжает в слайдер через `user.option` портала, и запись надо дождаться
   * (`usePortalSlider`). Наружу отдаётся синхронный `show` — обработчику клика ждать нечего.
   */
  async function showAsync(next: DrillRequest): Promise<void> {
    const mine = ++seq
    request.value = next
    rows.value = []
    error.value = undefined
    done.value = false
    // Страница закрытого списка ещё могла идти: её «читаем…» не наш, иначе новая первая
    // страница не стартовала бы никогда (сторож от двух страниц с одним курсором).
    pending.value = false
    params = plainDealListParams(next)
    afterId = 0
    const asked = await slider.openDrill({
      entity: 'deal',
      dealScope: 'plain',
      categoryId: input.filters.value.categoryId,
      title: next.title,
      filter: params.filter,
      ...(next.total === undefined ? {} : { total: next.total })
    })
    // ⚠ Пока ждали запись, могли нажать другое число: тогда эта панель уже не наша.
    if (mine !== seq) return
    if (asked) {
      // Панель прошлого клика гаснет: иначе она осталась бы под слайдером с чужим заголовком.
      open.value = false
      return
    }
    open.value = true
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
