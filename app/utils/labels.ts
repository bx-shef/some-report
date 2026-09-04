import type { ReportDictionaries } from '~/types/report'
import { UNSPECIFIED_REASON, UNSPECIFIED_SOURCE } from '~/utils/metrics'
import { UNKNOWN_SOURCE } from '~/utils/b24Adapter'

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

/** Подписи строк блока «Сделки без связи с лидом». */
export const NO_SOURCE_LABEL = 'Источник не указан'
export const UNKNOWN_SOURCE_LABEL = 'Источник вне справочника'

/**
 * Источник СДЕЛКИ без лида. Пустой источник здесь — не «другие», а именно «не указан»: на боевом
 * портале это 8 778 сделок из 9 191, главная строка блока, и назвать её «другими источниками»
 * значило бы спрятать факт, ради которого блок и заведён.
 */
export function unlinkedSourceLabel(dictionaries: ReportDictionaries, id: string): string {
  if (id === UNSPECIFIED_SOURCE) return NO_SOURCE_LABEL
  if (id === UNKNOWN_SOURCE) return UNKNOWN_SOURCE_LABEL
  return dictionaries.sources[id] ?? id
}
