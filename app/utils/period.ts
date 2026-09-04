import type { ReportPeriod } from '~/types/report'

/**
 * Периоды отчёта: готовые интервалы и арифметика границ.
 *
 * ⚠ Всё считается на ЛОКАЛЬНЫХ датах, а не через `Date.toISOString()`. `toISOString()` переводит
 * время в UTC, и восточнее Гринвича полночь 1 сентября превращается в 31 августа: отчёт молча
 * захватывал бы лишние сутки в начале периода и терял их в конце. Для отчёта, который сверяют с
 * CRM вручную, это худший вид ошибки — правдоподобный.
 *
 * Здесь только чистые функции: границы периода задают, ЧТО попадёт в выборку, и ошибка в них не
 * ломает отчёт, а тихо меняет все числа на экране.
 */

/** Локальная дата → `YYYY-MM-DD`. Именно локальная: см. предупреждение выше. */
export function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** `YYYY-MM-DD` → локальная дата (полночь). Непонятная строка даёт `undefined`, а не «дату-мусор». */
export function fromIsoDate(iso: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!match) return undefined
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  // Отсекаем 31 февраля и подобное: `new Date` такое молча переносит на следующий месяц.
  return toIsoDate(date) === iso.trim() ? date : undefined
}

/** Коды готовых интервалов. `custom` — руками выбранные даты. */
export type PeriodPresetId
  = | 'today'
    | 'yesterday'
    | 'last7'
    | 'last30'
    | 'this-month'
    | 'prev-month'
    | 'this-quarter'
    | 'this-year'
    | 'custom'

export interface PeriodPreset {
  id: PeriodPresetId
  label: string
  /** Границы интервала относительно «сегодня». У `custom` вычислителя нет. */
  resolve?: (today: Date) => ReportPeriod
}

function shiftDays(date: Date, days: number): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
  return result
}

function monthBounds(year: number, month: number): ReportPeriod {
  // День 0 следующего месяца — последний день текущего: так не нужно помнить про високосный год.
  return { from: toIsoDate(new Date(year, month, 1)), to: toIsoDate(new Date(year, month + 1, 0)) }
}

/**
 * Готовые интервалы.
 *
 * ⚠ Порядок не косметика: сверху то, что открывают чаще всего. «Текущий месяц» стоит первым не
 * из-за частоты, а потому что это умолчание отчёта — человек должен видеть, где он находится.
 *
 * ⚠ «Прошлый месяц» здесь обязателен. Отчёт, открытый 3-го числа, показывает три дня — то есть
 * почти пустой экран, который читается как поломка. Полный прошлый месяц в такие дни и есть тот
 * ответ, за которым пришли.
 */
export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  { id: 'this-month', label: 'Текущий месяц', resolve: today => monthBounds(today.getFullYear(), today.getMonth()) },
  { id: 'prev-month', label: 'Прошлый месяц', resolve: today => monthBounds(today.getFullYear(), today.getMonth() - 1) },
  { id: 'last7', label: 'Последние 7 дней', resolve: today => ({ from: toIsoDate(shiftDays(today, -6)), to: toIsoDate(today) }) },
  { id: 'last30', label: 'Последние 30 дней', resolve: today => ({ from: toIsoDate(shiftDays(today, -29)), to: toIsoDate(today) }) },
  { id: 'today', label: 'Сегодня', resolve: today => ({ from: toIsoDate(today), to: toIsoDate(today) }) },
  { id: 'yesterday', label: 'Вчера', resolve: (today) => {
    const day = toIsoDate(shiftDays(today, -1))
    return { from: day, to: day }
  } },
  { id: 'this-quarter', label: 'Текущий квартал', resolve: (today) => {
    const firstMonth = Math.floor(today.getMonth() / 3) * 3
    return {
      from: toIsoDate(new Date(today.getFullYear(), firstMonth, 1)),
      to: toIsoDate(new Date(today.getFullYear(), firstMonth + 3, 0))
    }
  } },
  { id: 'this-year', label: 'Текущий год', resolve: today => ({
    from: toIsoDate(new Date(today.getFullYear(), 0, 1)),
    to: toIsoDate(new Date(today.getFullYear(), 11, 31))
  }) },
  { id: 'custom', label: 'Произвольный' }
]

/** Границы готового интервала. Для `custom` вернёт `undefined` — его задаёт человек. */
export function resolvePreset(id: PeriodPresetId, today: Date): ReportPeriod | undefined {
  return PERIOD_PRESETS.find(preset => preset.id === id)?.resolve?.(today)
}

/**
 * Какому интервалу соответствуют выбранные даты.
 *
 * Нужно, чтобы после ручного ввода «01.09 — 30.09» подсветился пресет «Текущий месяц», а не
 * «Произвольный»: иначе человек видит, что система не понимает того, что он только что выбрал.
 */
export function matchPreset(period: ReportPeriod, today: Date): PeriodPresetId {
  for (const preset of PERIOD_PRESETS) {
    const bounds = preset.resolve?.(today)
    if (bounds && bounds.from === period.from && bounds.to === period.to) return preset.id
  }
  return 'custom'
}

/** Сколько дней в периоде, обе границы включительно. */
export function periodLengthDays(period: ReportPeriod): number {
  const from = fromIsoDate(period.from)
  const to = fromIsoDate(period.to)
  if (!from || !to) return 0
  /**
   * ⚠ Считаем по UTC-полуночам локальных календарных дат, а не разницей локальных `getTime()`.
   * В сутки перевода на летнее время 23 часа, и деление разницы на 86 400 000 с округлением вниз
   * недосчитывало день — а прогон в UTC этого не показывал, тест был зелёным по совпадению.
   */
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((utc(to) - utc(from)) / 86_400_000) + 1
}

export interface PeriodProblem {
  /** Сообщение человеку. Пусто — период годный. */
  message: string
  /** Исправленный период, если поправить можно однозначно. */
  fixed?: ReportPeriod
}

/**
 * Проверка периода перед запросом.
 *
 * ⚠ Проверяем ДО похода в портал. Перевёрнутый период (`от` больше `до`) REST принимает без
 * ошибки и возвращает пустой список — отчёт показал бы нули, неотличимые от «за период ничего не
 * было». Человек при этом ищет ошибку в CRM, а она у него на экране.
 */
export function validatePeriod(period: ReportPeriod, maxDays = 366): PeriodProblem | undefined {
  const from = fromIsoDate(period.from)
  const to = fromIsoDate(period.to)
  if (!from || !to) return { message: 'Даты периода заданы неверно.' }
  if (from.getTime() > to.getTime()) {
    return {
      message: 'Начало периода позже конца — даты поменяны местами.',
      fixed: { from: period.to, to: period.from }
    }
  }
  // ⚠ Ограничение не из осторожности: объём выборки растёт с периодом линейно, и на замеренных
  // объёмах заказчика (см. `docs/PORTAL.md`) год — это минуты ожидания во фрейме даже в режиме
  // счётчиков. Человек решит, что отчёт завис.
  if (periodLengthDays(period) > maxDays) {
    return { message: `Период больше ${maxDays} дней — выберите промежуток покороче, иначе выборка из портала займёт минуты.` }
  }
  return undefined
}
