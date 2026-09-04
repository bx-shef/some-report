import type { ReportDeal, ReportFilters, ReportLead } from '~/types/report'
import { INITIAL_LEAD_STATUS } from '~/utils/leadHistory'

/**
 * Фильтры отчёта (ТЗ от 2026-09-04): источник, менеджер, стадия лида, причина брака, причина
 * проигрыша сделки. Здесь — что они значат для запросов к порталу и для строк демо-набора.
 *
 * ⚠ Решения владельца от 2026-09-04: менеджер — ответственный ЛИДА, не сделки; «причина закрытия
 * лида» — стадия брака; «причина брака сделки» — причина проигрыша. На блок 7 (сделки без лида)
 * фильтры не действуют вовсе: «ты их все выводишь».
 *
 * Чистые функции: ни сети, ни SDK.
 */

export const EMPTY_FILTERS: ReportFilters = {}

/** Хоть один фильтр задан. */
export function hasFilters(filters: ReportFilters): boolean {
  return Boolean(filters.sourceId || filters.assignedById || filters.leadStatusId || filters.junkReasonId || filters.lossReasonKey)
}

/**
 * Стадия лида, по которой фильтруем: стадия ИЛИ причина брака — это одно и то же поле
 * `STATUS_ID`, поэтому вместе они не задаются; причина брака точнее и берёт верх.
 */
export function leadStatusFilter(filters: ReportFilters): string | undefined {
  return filters.junkReasonId || filters.leadStatusId || undefined
}

/**
 * Фрагмент REST-фильтра для ЛИДОВ (счётчики, строки для истории, список ID). Пустые значения не
 * попадают в фильтр вовсе: `SOURCE_ID: ''` в разных версиях портала значит разное.
 */
export function leadRestFilter(filters: ReportFilters): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (filters.sourceId) out.SOURCE_ID = filters.sourceId
  if (filters.assignedById) out.ASSIGNED_BY_ID = filters.assignedById
  const status = leadStatusFilter(filters)
  if (status) out.STATUS_ID = status
  return out
}

/**
 * Фильтры, которых у СДЕЛКИ нет полем: менеджер и стадия — это поля лида. Такие фильтры
 * применяются к сделкам через список ID лидов (`LEAD_ID in (...)`).
 */
export function needsLeadIds(filters: ReportFilters): boolean {
  return Boolean(filters.assignedById || leadStatusFilter(filters))
}

/**
 * Фрагмент REST-фильтра для СДЕЛОК ИЗ ЛИДОВ. Источник у сделки свой (портал копирует его из лида
 * при конвертации) — фильтруем прямо. Причина проигрыша — стадии провала под каноничным ключом
 * (`reasonMerge`): одна причина в четырёх направлениях — несколько кодов, поэтому `STAGE_ID` —
 * массив. Причина, у которой кодов нет (удалена), даёт заведомо пустую выборку, а не все сделки.
 */
export function dealRestFilter(filters: ReportFilters, codesByReasonKey: Record<string, string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  if (filters.sourceId) out.SOURCE_ID = filters.sourceId
  if (filters.lossReasonKey) out.STAGE_ID = codesByReasonKey[filters.lossReasonKey] ?? ['__no_such_stage__']
  return out
}

/** Коды стадий провала по каноничному ключу причины — обратная карта к `keyByCode`. */
export function codesByReason(keyByCode: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null)
  for (const [code, key] of Object.entries(keyByCode)) (out[key] ??= []).push(code)
  return out
}

/** Порезать список ID на куски: фильтр `LEAD_ID in (...)` в одном запросе не должен быть безразмерным. */
export function chunkIds(ids: readonly number[], size = 500): number[][] {
  const out: number[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * Те же фильтры для СТРОК демо-набора — чтобы предпросмотр вне портала вёл себя как живой отчёт.
 *
 * Правила те же, что у запросов: менеджер и стадия — по лиду (сделка остаётся, если остался её
 * лид), источник — у лида и у сделки свой, причина проигрыша — только по сделкам.
 */
export function applyFilters(leads: ReportLead[], deals: ReportDeal[], filters: ReportFilters): { leads: ReportLead[], deals: ReportDeal[] } {
  if (!hasFilters(filters)) return { leads, deals }
  const status = leadStatusFilter(filters)
  const keptLeads = leads.filter((lead) => {
    if (filters.sourceId && lead.sourceId !== filters.sourceId) return false
    if (filters.assignedById && lead.assignedById !== filters.assignedById) return false
    if (status) {
      const leadStatus = lead.outcome === 'junk' ? (lead.junkReasonId ?? '') : lead.outcome === 'converted' ? 'CONVERTED' : lead.firstResponseAt ? '1' : INITIAL_LEAD_STATUS
      if (leadStatus !== status) return false
    }
    return true
  })
  const leadIds = new Set(keptLeads.map(l => l.id))
  const keptDeals = deals.filter((deal) => {
    if (needsLeadIds(filters) && (deal.leadId === undefined || !leadIds.has(deal.leadId))) return false
    if (filters.sourceId && deal.sourceId !== filters.sourceId) return false
    if (filters.lossReasonKey && deal.lossReasonId !== filters.lossReasonKey) return false
    return true
  })
  return { leads: keptLeads, deals: keptDeals }
}
