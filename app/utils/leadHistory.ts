import type { ReportLead } from '~/types/report'

/**
 * История стадий лида → строки лидов с временем первого ответа.
 *
 * ⚠ «Первый ответ» — первый уход лида со стадии «Не обработан», куда угодно: в работу, в брак,
 * сразу в сделку (решение владельца от 2026-09-04 по ответу заказчика: «стадия „взят в работу“ —
 * это и есть действие»). Момент ухода живёт только в `crm.stagehistory.list`: у самого лида
 * есть лишь `DATE_MODIFY`, а его меняет любая правка карточки.
 *
 * Чистые функции: ни сети, ни `Date.now()`. Ядро (`processingMetrics`) дальше считает по этим
 * строкам то же, что и по демо-набору, — формулы одни.
 */

/** Строка `crm.stagehistory.list` для лида (`entityTypeId: 1`). У лидов стадия — `STATUS_ID`. */
export interface B24StageHistoryRow {
  ID: string | number
  /** 1 — создание, 2 — переход, 3 — закрытие (успех или провал). */
  TYPE_ID?: string | number | null
  OWNER_ID: string | number
  CREATED_TIME: string
  STATUS_ID?: string | null
}

/** Строка `crm.lead.list`, нужная истории: когда создан и откуда пришёл. */
export interface B24LeadHistoryRow {
  ID: string | number
  DATE_CREATE?: string | null
  SOURCE_ID?: string | null
  STATUS_ID?: string | null
}

/** Начальная стадия лида — системная `NEW` («Не обработан»): её нельзя удалить или переименовать кодом. */
export const INITIAL_LEAD_STATUS = 'NEW'

function toId(value: string | number | null | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Собрать строки лидов: у каждого — создание, источник и момент первого ухода из `NEW`.
 *
 * Лиды берутся из СТРОК ЛИДОВ (они определяют множество «лиды периода»), история — только как
 * источник времени. Переход без лида в списке (лид другого периода) отбрасывается; лид без
 * перехода — необработанный (`firstResponseAt` пуст). Запись самого создания (`STATUS_ID = NEW`)
 * ответом не считается, даже если портал положил её в историю с задержкой.
 */
export function leadsFromHistory(
  leads: readonly B24LeadHistoryRow[],
  history: readonly B24StageHistoryRow[],
  /** Код стадии брака → true; чтобы `outcome` лида был честным, а не «в работе» для всех. */
  junkStatusIds: readonly string[] = [],
  convertedStatusIds: readonly string[] = [],
  initialStatus = INITIAL_LEAD_STATUS
): ReportLead[] {
  const firstResponse = new Map<number, string>()
  for (const row of history) {
    const status = (row.STATUS_ID ?? '').trim()
    // Запись создания сразу в стадии не-NEW — тоже ответ, в момент создания: лид никогда не был
    // «не обработан», и счётчик `NEW` его обработанным считает. Запись создания в `NEW` — нет.
    if (!status || status === initialStatus) continue
    const owner = toId(row.OWNER_ID)
    const at = row.CREATED_TIME
    if (!owner || !at) continue
    const known = firstResponse.get(owner)
    if (!known || Date.parse(at) < Date.parse(known)) firstResponse.set(owner, at)
  }
  const junk = new Set(junkStatusIds)
  const converted = new Set(convertedStatusIds)
  const seen = new Set<number>()
  const result: ReportLead[] = []
  for (const row of leads) {
    const id = toId(row.ID)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const status = (row.STATUS_ID ?? '').trim()
    const at = firstResponse.get(id)
    result.push({
      id,
      createdAt: row.DATE_CREATE ?? '',
      sourceId: (row.SOURCE_ID ?? '').trim(),
      assignedById: 0,
      outcome: junk.has(status) ? 'junk' : converted.has(status) ? 'converted' : 'in-work',
      ...(junk.has(status) ? { junkReasonId: status } : {}),
      dealIds: [],
      ...(at ? { firstResponseAt: at } : {})
    })
  }
  return result
}
