import type { ReportDictionaries } from '~/types/report'
import { statusNames, type B24StatusRow } from '~/utils/b24Adapter'
import { dictionaryBatch } from '~/utils/b24Query'
import { stageListParams } from '~/utils/managerQuery'
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
import { DRILL_PAGE_SIZE } from '~/composables/useDrilldown'

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
  /**
   * Направление, для которого справочники уже СПРАШИВАЛИ, — они не меняются, пока человек листает.
   *
   * ⚠ Отметка ставится ДО ответа портала и не снимается при сбое, и это не забывчивость. Сбой
   * справочников подписывает строки кодами; повтори мы попытку на второй странице, удачный ответ
   * подписал бы словами ТОЛЬКО её — один список, две системы подписей, и никакого объяснения на
   * экране. Числа от этого не зависят вовсе, а разнобой замечают и считают ошибкой данных.
   *
   * ⚠ Ключ — направление, а не просто «читали»: у каждого направления стадии свои
   * (`DEAL_STAGE_<id>`), и повторный `start` с другим направлением обязан спросить заново.
   */
  let booksFor: number | undefined

  async function readBooks(categoryId: number): Promise<void> {
    if (booksFor === categoryId) return
    booksFor = categoryId
    // Сотрудники читаются параллельно и никого не ждут: от их имён список не зависит.
    const usersPromise = fetchUsers()
    try {
      // Один пакет вместо четырёх кругов по сети: справочники нужны все сразу, до первой строки.
      const books = dictionaryBatch()
      const answers = await batchRows<B24StatusRow>({
        sources: books.sources,
        leadStatuses: books.leadStatuses,
        // ⚠ Стадии берём НУЖНОГО направления, а не только направления по умолчанию: у каждого
        // они свои (`DEAL_STAGE_<id>`). Иначе список, открытый из направления 1, печатал бы
        // `C1:NEW` там, где в таблице над ним написано «Новая».
        dealStages: { method: 'crm.status.list', params: stageListParams(categoryId) }
      })
      // ⚠ Имена сотрудников НЕ ждём: они приходят вторым проходом `user.get` по всему порталу, и
      // ожидание задержало бы первую строку списка на секунды. Пришли — подставятся, нет —
      // строка подпишется «Сотрудник #17». Числа от этого не зависят.
      void usersPromise.then((users) => {
        dictionaries = { ...dictionaries, users: users.names }
      })
      dictionaries = {
        sources: statusNames(answers.sources ?? []),
        junkReasons: {},
        lossReasons: {},
        // ⚠ Ключ пакета `leadStatuses`, а поле словаря — `leadStages`: имена разные, и потерять
        // здесь букву значит подписать стадии лида кодами при совершенно рабочем справочнике.
        leadStages: statusNames(answers.leadStatuses ?? []),
        // ⚠ Подписи из нагрузки — ПОВЕРХ справочника портала, а не под ним. В отчёте по лидам за
        // числом стоит каноничное название причины провала, сведённое из стадий четырёх
        // направлений; справочник одного направления назвал бы ту же стадию по-своему, и список
        // разошёлся бы в словах с числом, по которому нажали.
        dealStages: { ...statusNames(answers.dealStages ?? []), ...(payload?.stageNames ?? {}) },
        ...(dictionaries.users ? { users: dictionaries.users } : {})
      }
    } catch {
      // Подписи — удобство, а не данные: без них строки подпишутся кодами, числа те же. Но то,
      // что приехало готовым в нагрузке, справочников не ждёт и остаётся словами.
      if (payload?.stageNames) dictionaries = { ...dictionaries, dealStages: { ...payload.stageNames } }
    }
  }

  /** Следующая страница списка. Первая — она же. */
  async function loadMore(): Promise<void> {
    if (!payload || pending.value || done.value) return
    pending.value = true
    error.value = undefined
    try {
      await readBooks(payload.categoryId ?? 0)
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
      // ⚠ Охват приезжает в нагрузке: у `unlinked` строка берёт дату ЗАКРЫТИЯ, а не создания —
      // иначе сделка, закрытая в сентябре и созданная в мае, попала бы в сентябрьский список с
      // датой «май», и список разошёлся бы с числом над ним.
      const scope = payload.dealScope ?? 'plain'
      const mapped = page.map(row => isLead
        ? leadDrillRow(row as B24DrillLeadRow, dictionaries)
        : dealDrillRow(row as B24DrillDealRow, dictionaries, {}, scope))
      rows.value = [...rows.value, ...mapped]
      const last = mapped.reduce((max, row) => Math.max(max, row.id), 0)
      // ⚠ Курсор не сдвинулся — список закрываем. Иначе «Показать ещё» доклеивало бы ту же
      // страницу без конца: такое бывает, когда портал вернул строки с неразбираемым `ID`.
      if (!Number.isFinite(last) || last <= afterId || page.length < DRILL_PAGE_SIZE) done.value = true
      afterId = Math.max(afterId, last)
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
