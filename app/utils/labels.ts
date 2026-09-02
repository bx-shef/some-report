import type { ReportDictionaries } from '~/types/report'
import { UNSPECIFIED_REASON, UNSPECIFIED_SOURCE } from '~/utils/metrics'

/**
 * Код → имя для печати. Отдельным модулем, потому что «что показать вместо неизвестного кода» —
 * решение, а не форматирование: показать сам код (`UC_X4F2K1`) значит показать мусор, а спрятать
 * строку — потерять её вклад в итог, который при этом останется на месте.
 */

/** Что печатаем вместо служебных кодов «не заполнено». */
export const UNSPECIFIED_SOURCE_LABEL = 'Другие источники'
export const UNSPECIFIED_REASON_LABEL = 'Причина не указана'

/**
 * Имя по коду. Неизвестный портальный код печатается КАК ЕСТЬ: по нему запись хотя бы можно найти
 * в CRM, тогда как «—» превращает строку в загадку.
 */
export function labelFor(dictionary: Record<string, string>, id: string, fallback: string): string {
  if (id === UNSPECIFIED_SOURCE || id === UNSPECIFIED_REASON) return fallback
  return dictionary[id] ?? id
}

export function sourceLabel(dictionaries: ReportDictionaries, id: string): string {
  return labelFor(dictionaries.sources, id, UNSPECIFIED_SOURCE_LABEL)
}

export function junkReasonLabel(dictionaries: ReportDictionaries, id: string): string {
  return labelFor(dictionaries.junkReasons, id, UNSPECIFIED_REASON_LABEL)
}

export function lossReasonLabel(dictionaries: ReportDictionaries, id: string): string {
  return labelFor(dictionaries.lossReasons, id, UNSPECIFIED_REASON_LABEL)
}
