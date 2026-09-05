import type { ManagerFilters } from '~/types/managers'
import type { ReportFilters, ReportPeriod } from '~/types/report'
import { SCOPE_LABELS } from '~/utils/managerLoad'
import { fromIsoDate, validatePeriod } from '~/utils/period'

/**
 * Отбор, запомненный порталом: что именно сохраняем в `user.option` и как читаем обратно.
 *
 * ⚠ Разбор ПРОВЕРЯЮЩИЙ, а не доверяющий, и это не паранойя. В настройках лежит то, что мы
 * записали ПРОШЛОЙ версией приложения и что человек мог унаследовать с другого портала: удалённое
 * направление, источник, которого больше нет, период на пять лет. Восстановить такое молча
 * значит открыть отчёт с отбором, которого человек не выбирал, — и он будет искать ошибку в
 * данных. Всё, что не прошло проверку, отбрасывается, и отчёт открывается со своим умолчанием.
 *
 * ⚠ Модуль чистый: ни SDK, ни сети. Вызовы `user.option.get/set` — в `useUserOptions.ts`.
 */

/** Ключи настроек. С версией: формат отбора менялся дважды за две недели и будет меняться ещё. */
export const LEADS_OPTION_KEY = 'report.leads.v1'
export const MANAGERS_OPTION_KEY = 'report.managers.v1'

/** Сохранённое состояние отчёта по лидам. */
export interface SavedLeadsState {
  period?: ReportPeriod
  filters?: ReportFilters
}

/** Сохранённое состояние отчёта по менеджерам — тот же отбор, что в панели. */
export interface SavedManagersState {
  categoryId?: number
  scope?: ManagerFilters['scope']
  period?: ReportPeriod
  companyId?: number
}

/** Сохранённое значение → объект. Строка (так его отдаёт портал), объект или мусор. */
function parse(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
    } catch {
      // Мусор в настройке — не ошибка отчёта: открываемся с умолчанием и молчим.
      return undefined
    }
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
}

/**
 * Период из сохранённого — только годный.
 *
 * ⚠ Проверяем той же `validatePeriod`, что и панель: иначе через настройки в отчёт заезжал бы
 * период, который через интерфейс выбрать нельзя (перевёрнутый или длиной в пять лет).
 */
function readPeriod(value: unknown): ReportPeriod | undefined {
  const raw = parse(value)
  const from = raw?.from
  const to = raw?.to
  if (typeof from !== 'string' || typeof to !== 'string') return undefined
  if (!fromIsoDate(from) || !fromIsoDate(to)) return undefined
  const period = { from, to }
  return validatePeriod(period) ? undefined : period
}

/** Натуральное число или `undefined`. `0` допустим только там, где он значение (см. компанию). */
function readNumber(value: unknown, allowZero = false): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || !Number.isInteger(number)) return undefined
  if (number < 0) return undefined
  return number === 0 && !allowZero ? undefined : number
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Что сохранить для отчёта по лидам. */
export function encodeLeadsState(period: ReportPeriod, filters: ReportFilters): string {
  return JSON.stringify({ period, filters })
}

/**
 * Что восстановить для отчёта по лидам.
 *
 * ⚠ Значения фильтров НЕ сверяются со справочниками портала, и это осознанно: справочники к
 * этому моменту ещё не прочитаны, а ждать их значит задержать первую выборку. Отбор по
 * несуществующему источнику даёт пустой отчёт с честной подписью «под этим отбором лидов нет» —
 * и фильтр видно на экране, его можно снять одним нажатием.
 */
export function decodeLeadsState(raw: unknown): SavedLeadsState {
  const data = parse(raw)
  if (!data) return {}
  const filters = parse(data.filters) ?? {}
  const restored: ReportFilters = {
    ...(readString(filters.sourceId) === undefined ? {} : { sourceId: readString(filters.sourceId)! }),
    ...(readNumber(filters.assignedById) === undefined ? {} : { assignedById: readNumber(filters.assignedById)! }),
    ...(readString(filters.leadStatusId) === undefined ? {} : { leadStatusId: readString(filters.leadStatusId)! }),
    ...(readString(filters.junkReasonId) === undefined ? {} : { junkReasonId: readString(filters.junkReasonId)! }),
    ...(readString(filters.lossReasonKey) === undefined ? {} : { lossReasonKey: readString(filters.lossReasonKey)! })
  }
  const period = readPeriod(data.period)
  return {
    ...(period ? { period } : {}),
    ...(Object.keys(restored).length ? { filters: restored } : {})
  }
}

/** Что сохранить для отчёта по менеджерам. */
export function encodeManagersState(filters: ManagerFilters): string {
  return JSON.stringify({
    categoryId: filters.categoryId,
    scope: filters.scope,
    period: filters.period,
    ...(filters.companyId === undefined ? {} : { companyId: filters.companyId })
  })
}

/**
 * Что восстановить для отчёта по менеджерам.
 *
 * ⚠ Направление не сверяется со списком портала здесь — это делает сама выборка: если
 * направление удалили, `useManagerReport` берёт первое из списка и говорит об этом подписью.
 * Дублировать проверку значит завести второе место, где решается один и тот же вопрос.
 */
export function decodeManagersState(raw: unknown): SavedManagersState {
  const data = parse(raw)
  if (!data) return {}
  const categoryId = readNumber(data.categoryId, true)
  const scope = readString(data.scope)
  const period = readPeriod(data.period)
  // ⚠ Ноль здесь ЗНАЧЕНИЕ («Без моей компании»), а не «не задано»: `allowZero`.
  const companyId = readNumber(data.companyId, true)
  return {
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(scope !== undefined && scope in SCOPE_LABELS ? { scope: scope as ManagerFilters['scope'] } : {}),
    ...(period ? { period } : {}),
    ...(companyId === undefined ? {} : { companyId })
  }
}
