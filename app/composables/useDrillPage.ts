import type { ReportDictionaries } from '~/types/report'
import { statusNames, type B24StatusRow } from '~/utils/b24Adapter'
import { dictionaryBatch } from '~/utils/b24Query'
import {
  type B24DrillDealRow,
  type B24DrillLeadRow,
  type DrillRow,
  DRILL_DEAL_SELECT,
  DRILL_LEAD_SELECT,
  dealDrillRow,
  leadDrillRow
} from '~/utils/drilldown'
import type { DrillSliderPayload } from '~/utils/drillSlider'

/** Страница списка — как у списочных методов портала. */
export const DRILL_PAGE_SIZE = 50

/**
 * Данные страницы детализации, открытой настоящим слайдером портала.
 *
 * ⚠ Это ОТДЕЛЬНЫЙ фрейм: состояния отчёта здесь нет вовсе. Условие приезжает готовым фильтром в
 * параметрах вызова (`drillSlider.ts`), а справочники для подписей страница читает сама — иначе
 * список печатал бы `PROCES_DELIVERY` и `SOURCE_1` вместо слов.
 *
 * ⚠ Цена такого устройства — справочники на каждое открытие: пакет из трёх `crm.status.list` плюс
 * сотрудники. Это осознанный размен на то, что слайдер настоящий и накрывает портал целиком, а не
 * наш фрейм. Числа от справочников не зависят: не прочитались — строки подпишутся кодами.
 *
 * ⚠ Листание — курсором по `ID`, как во всех выборках отчёта: `start: -1` с фильтром `>ID`.
 * Смещением (`start: N`) портал на больших списках отдаёт дубли и пропуски.
 */
export function useDrillPage() {
  const b24 = useB24()
  const { batchRows } = useB24Batch()
  const { fetchUsers } = useB24Users()

  const rows = ref<DrillRow[]>([])
  const pending = ref(false)
  const error = ref<string | undefined>(undefined)
  /** Все страницы прочитаны. */
  const done = ref(false)

  let payload: DrillSliderPayload | undefined
  let dictionaries: ReportDictionaries = { sources: {}, junkReasons: {}, lossReasons: {} }
  let afterId = 0
  /** Справочники читаются один раз на страницу: они не меняются, пока человек листает список. */
  let booksLoaded = false

  async function readBooks(): Promise<void> {
    if (booksLoaded) return
    booksLoaded = true
    // Сотрудники читаются параллельно и никого не ждут: от их имён список не зависит.
    const usersPromise = fetchUsers()
    try {
      // Один пакет вместо четырёх кругов по сети: справочники нужны все сразу, до первой строки.
      const books = dictionaryBatch()
      const answers = await batchRows<B24StatusRow>({
        sources: books.sources,
        leadStatuses: books.leadStatuses,
        dealStages: books.dealStages
      })
      const users = await usersPromise
      dictionaries = {
        sources: statusNames(answers.sources ?? []),
        junkReasons: {},
        lossReasons: {},
        // ⚠ Ключ пакета `leadStatuses`, а поле словаря — `leadStages`: имена разные, и потерять
        // здесь букву значит подписать стадии лида кодами при совершенно рабочем справочнике.
        leadStages: statusNames(answers.leadStatuses ?? []),
        dealStages: statusNames(answers.dealStages ?? []),
        users: users.names
      }
    } catch {
      // Подписи — удобство, а не данные: без них строки подпишутся кодами, числа те же.
    }
  }

  /** Следующая страница списка. Первая — она же. */
  async function loadMore(): Promise<void> {
    if (!payload || pending.value || done.value) return
    pending.value = true
    error.value = undefined
    try {
      await readBooks()
      const frame = b24.getOrThrow()
      const isLead = payload.entity === 'lead'
      const result = await frame.actions.v2.call.make<Array<B24DrillLeadRow | B24DrillDealRow>>({
        method: isLead ? 'crm.lead.list' : 'crm.deal.list',
        params: {
          filter: { ...payload.filter, '>ID': afterId },
          select: isLead ? [...DRILL_LEAD_SELECT] : [...DRILL_DEAL_SELECT],
          order: { ID: 'ASC' },
          start: -1
        }
      })
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      const page = (result.getData()?.result ?? []) as Array<B24DrillLeadRow | B24DrillDealRow>
      const mapped = page.map(row => isLead
        ? leadDrillRow(row as B24DrillLeadRow, dictionaries)
        // ⚠ Охват `plain`: фильтр пришёл готовым, и дату строка берёт по созданию — как в отчёте
        // «Сделки по менеджерам», откуда такой список и открывают.
        : dealDrillRow(row as B24DrillDealRow, dictionaries, {}, 'plain'))
      rows.value = [...rows.value, ...mapped]
      afterId = mapped.reduce((max, row) => Math.max(max, row.id), afterId)
      if (page.length < DRILL_PAGE_SIZE) done.value = true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      pending.value = false
    }
  }

  /** Начать список по нагрузке слайдера. */
  async function start(next: DrillSliderPayload): Promise<void> {
    payload = next
    rows.value = []
    afterId = 0
    done.value = false
    error.value = undefined
    await loadMore()
  }

  return { rows, pending, error, done, start, loadMore }
}
