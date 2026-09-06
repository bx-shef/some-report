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
 * ⚠ Цена такого устройства — справочники на каждое открытие: пакет `crm.status.list` плюс
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

  /**
   * Сырые строки портала, а не готовые к показу.
   *
   * ⚠ Подписи навешиваются в `rows` ВЫЧИСЛЕНИЕМ, и это не украшательство. Имена сотрудников
   * приходят вторым проходом `user.get` по всему порталу и запросто опаздывают за первой
   * страницей. Разложи мы строки один раз при получении — первая страница осталась бы с
   * «Сотрудник #7», вторая приехала бы с фамилией, и один список получил бы две системы подписей
   * без единого объяснения на экране. Теперь опоздавший справочник перерисовывает ВСЮ таблицу.
   */
  const raw = ref<Array<B24DrillLeadRow | B24DrillDealRow>>([])
  const dictionaries = ref<ReportDictionaries>({ sources: {}, junkReasons: {}, lossReasons: {} })
  const payload = ref<DrillSliderPayload | undefined>(undefined)
  const pending = ref(false)
  const error = ref<string | undefined>(undefined)
  /** Все страницы прочитаны. */
  const done = ref(false)

  /** Строки списка — сырые записи, подписанные ТЕКУЩИМИ справочниками. */
  const rows = computed<DrillRow[]>(() => {
    const isLead = payload.value?.entity === 'lead'
    // ⚠ Охват приезжает в нагрузке: у `unlinked` строка берёт дату ЗАКРЫТИЯ, а не создания —
    // иначе сделка, закрытая в сентябре и созданная в мае, попала бы в сентябрьский список с
    // датой «май», и список разошёлся бы с числом над ним.
    const scope = payload.value?.dealScope ?? 'plain'
    return raw.value.map(row => isLead
      ? leadDrillRow(row as B24DrillLeadRow, dictionaries.value)
      : dealDrillRow(row as B24DrillDealRow, dictionaries.value, {}, scope))
  })

  /**
   * Номер открытого списка: ответ сменённого списка выбрасывается.
   *
   * ⚠ Тот же сторож, что у панели отчёта. Без него повторный `start` на неотвеченной странице
   * доклеил бы ответ ПРОШЛОГО условия к очищенным строкам — записи одного числа под заголовком
   * другого, и «показано M из N» мимо N.
   */
  let seq = 0
  let afterId = 0
  /**
   * Направление, для которого справочники уже СПРАШИВАЛИ, — они не меняются, пока человек листает.
   *
   * ⚠ Отметка ставится ДО ответа портала и не снимается при сбое, и это не забывчивость. Сбой
   * справочников подписывает строки кодами; повтори мы попытку на второй странице, удачный ответ
   * подписал бы словами ТОЛЬКО её — и снова один список, две системы подписей.
   *
   * ⚠ Ключ — направление, а не просто «читали»: у каждого направления стадии свои
   * (`DEAL_STAGE_<id>`), и повторный `start` с другим направлением обязан спросить заново.
   */
  let booksFor: string | undefined

  async function readBooks(current: DrillSliderPayload): Promise<void> {
    const isLead = current.entity === 'lead'
    const categoryId = current.categoryId ?? 0
    const mark = isLead ? 'lead' : `deal:${categoryId}`
    if (booksFor === mark) return
    booksFor = mark

    // ⚠ Имена сотрудников НЕ ждём и подписываем ими строки СРАЗУ, как придут, — до и независимо
    // от справочников. Раньше это стояло после `await` пакета: сбой справочников уводил в `catch`,
    // и совершенно исправный список сотрудников пропадал вместе с ними.
    void fetchUsers()
      .then((users) => {
        dictionaries.value = { ...dictionaries.value, users: users.names }
      })
      .catch(() => undefined)

    try {
      // Один пакет вместо трёх кругов по сети: справочники нужны все сразу, до первой строки.
      const books = dictionaryBatch()
      const answers = await batchRows<B24StatusRow>({
        sources: books.sources,
        leadStatuses: books.leadStatuses,
        // ⚠ Стадии сделок — только СПИСКУ СДЕЛОК и только НУЖНОГО направления: у каждого они свои
        // (`DEAL_STAGE_<id>`). Список лидов их не касается вовсе, и лишняя команда в пакете —
        // ответ, который некуда деть.
        ...(isLead ? {} : { dealStages: { method: 'crm.status.list', params: stageListParams(categoryId) } })
      })
      dictionaries.value = {
        ...dictionaries.value,
        sources: statusNames(answers.sources ?? []),
        // ⚠ Ключ пакета `leadStatuses`, а поле словаря — `leadStages`: имена разные, и потерять
        // здесь букву значит подписать стадии лида кодами при совершенно рабочем справочнике.
        leadStages: statusNames(answers.leadStatuses ?? []),
        // ⚠ Подписи из нагрузки — ПОВЕРХ справочника портала, а не под ним. В отчёте по лидам за
        // числом стоит каноничное название причины провала, сведённое из стадий четырёх
        // направлений; справочник одного направления назвал бы ту же стадию по-своему, и список
        // разошёлся бы в словах с числом, по которому нажали.
        dealStages: { ...statusNames(answers.dealStages ?? []), ...(current.stageNames ?? {}) }
      }
    } catch {
      // Подписи — удобство, а не данные: без них строки подпишутся кодами, числа те же. Но то,
      // что приехало готовым в нагрузке, справочников не ждёт и остаётся словами.
      if (current.stageNames) {
        dictionaries.value = { ...dictionaries.value, dealStages: { ...current.stageNames } }
      }
    }
  }

  /** Следующая страница списка. Первая — она же. */
  async function loadMore(mine = seq): Promise<void> {
    const current = payload.value
    if (!current || pending.value || done.value || mine !== seq) return
    pending.value = true
    error.value = undefined
    try {
      await readBooks(current)
      if (mine !== seq) return
      const frame = b24.getOrThrow()
      const isLead = current.entity === 'lead'
      const result = await frame.actions.v2.call.make<Array<B24DrillLeadRow | B24DrillDealRow>>({
        method: isLead ? 'crm.lead.list' : 'crm.deal.list',
        params: {
          // ⚠ Курсор ПОСЛЕ фильтра нагрузки: пришли бы они наоборот, подделанный `>ID` перебил бы
          // наш курсор, и список листался бы по чужому условию.
          filter: { ...current.filter, '>ID': afterId },
          select: isLead ? [...DRILL_LEAD_SELECT] : [...DRILL_DEAL_SELECT],
          order: { ID: 'ASC' },
          start: -1
        }
      })
      if (mine !== seq) return
      if (!result.isSuccess) throw new Error(result.getErrorMessages().join('; '))
      const page = (result.getData()?.result ?? []) as Array<B24DrillLeadRow | B24DrillDealRow>
      raw.value = [...raw.value, ...page]
      const last = page.reduce((max, row) => Math.max(max, Number(row.ID) || 0), 0)
      // ⚠ Курсор не сдвинулся — список закрываем. Иначе «Показать ещё» доклеивало бы ту же
      // страницу без конца: такое бывает, когда портал вернул строки с неразбираемым `ID`.
      if (!Number.isFinite(last) || last <= afterId || page.length < DRILL_PAGE_SIZE) done.value = true
      afterId = Math.max(afterId, last)
    } catch (e) {
      if (mine === seq) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (mine === seq) pending.value = false
    }
  }

  /** Начать список по нагрузке слайдера. */
  async function start(next: DrillSliderPayload): Promise<void> {
    const mine = ++seq
    payload.value = next
    raw.value = []
    afterId = 0
    done.value = false
    error.value = undefined
    // Страница прошлого списка ещё могла идти: её «читаем…» не наш, иначе новая первая страница
    // не стартовала бы никогда (сторож от двух страниц с одним курсором).
    pending.value = false
    await loadMore(mine)
  }

  return { rows, pending, error, done, start, loadMore }
}
