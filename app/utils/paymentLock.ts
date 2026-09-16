/**
 * Приостановка приложения при незавершённом приёме работ — чистое ядро.
 *
 * Отчёты сделаны и выкачены; пока приём выполненных работ не оформлен, приложение сначала НАПОМИНАЕТ об этом
 * экраном с отсчётом, а потом перестаёт открываться совсем. Здесь — только арифметика решения:
 * какой сегодня календарный день, что из этого следует и что разрешено обходу из адреса.
 *
 * ⚠ Дат в этом файле НЕТ И БЫТЬ НЕ ДОЛЖНО, и это не стиль. Во-первых, репозиторий видит заказчик:
 * строка «заблокировать их 17-го» в коде — плохой способ вести разговор об оплате. Во-вторых,
 * снимать блокировку придётся быстро, а пересборка образа и выкат — это минуты и новый коммит в
 * `main`. Поэтому расписание приезжает С СЕРВЕРА (`/payment-lock.json`, переменные окружения
 * контейнера), а здесь живёт только разбор того, что приехало.
 *
 * Чистые функции: ни сети, ни `Date.now()` — «сейчас» приходит параметром.
 */

/**
 * Что делает приложение прямо сейчас.
 * - `none` — работает как обычно;
 * - `soft` — показывает экран, через `LOCK_RELEASE_SECONDS` пускает дальше;
 * - `hard` — показывает экран и дальше не пускает.
 */
export type PaymentLockStage = 'none' | 'soft' | 'hard'

/** Расписание блокировки — ровно то, что приехало с сервера. */
export interface PaymentLockSchedule {
  /** Календарный день, с которого показывается экран с отсчётом (`YYYY-MM-DD`). */
  softFrom?: string
  /** Календарный день, с которого экран уже не снимается (`YYYY-MM-DD`). */
  hardFrom?: string
  /** Рубильник «оплачено»: блокировки нет, какими бы ни были даты. */
  off?: boolean
}

/**
 * Сколько секунд показывается мягкий экран, прежде чем пустить дальше.
 *
 * ⚠ Константа кода, а не настройка сервера — намеренно. Настройками управляют даты и рубильник;
 * длительность паузы — часть ХАРАКТЕРА напоминания, и менять её на живом сервере незачем.
 */
export const LOCK_RELEASE_SECONDS = 20

/** Порядок строгости: обход из адреса может только ПОВЫСИТЬ стадию, но не понизить. */
const STAGE_RANK: Record<PaymentLockStage, number> = { none: 0, soft: 1, hard: 2 }

/** Календарный день — `YYYY-MM-DD`, целое число, без ведущего нуля отдельным случаем. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Календарный день «сейчас» ПО МЕСТНОМУ времени, строкой `YYYY-MM-DD`.
 *
 * ⚠ Местный, а не UTC, и это важно: «с 17 сентября» человек говорит про календарь у себя на
 * стене. Портал заказчика живёт в UTC+3, и сравнение по UTC включило бы блокировку в три часа
 * ночи 18-го вместо полуночи 17-го — то есть на сутки позже, чем обещано в переписке.
 *
 * ⚠ Сравнивать даты строками можно ровно потому, что формат `YYYY-MM-DD` лексикографически
 * совпадает с хронологическим порядком. Это свойство формата, а не удача: смена формата ломает
 * сравнение молча, поэтому разбор и сравнение живут в одном модуле.
 */
export function localDayKey(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Строка — настоящий календарный день, а не «2026-13-45» и не «сегодня». */
function validDayKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DAY_KEY.test(value)) return undefined
  // ⚠ Проверка round-trip'ом: `new Date('2026-02-31')` не бросает, а молча даёт 3 марта, и
  // блокировка включилась бы на два дня раньше объявленного.
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : value
}

/**
 * Рубильник из окружения. Строкой, потому что через JSON сервера всё приезжает строкой.
 *
 * ⚠ Разрешены только явные «да». Всё остальное — включая `'false'`, `'0'` и опечатку — это «не
 * выключено»: рубильник обязан требовать осознанного действия, а не срабатывать от мусора.
 */
function truthy(value: unknown): boolean {
  if (value === true) return true
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/**
 * Разбор настроек, приехавших с сервера, — ПРОВЕРЯЮЩИЙ, как сохранённый отбор.
 *
 * ⚠ Негодное поле отбрасывается, а не «понимается как сможем»: опечатка в дате не должна
 * превращаться в блокировку на случайный день. И весь разбор устроен так, чтобы ошибка уводила В
 * СТОРОНУ РАБОТАЮЩЕГО отчёта: сломанный файл настроек, пустой ответ или мусор в переменной
 * окружения дают `none`. Запереть оплатившего клиента из-за своей же опечатки хуже, чем не
 * показать напоминание.
 */
export function parseLockSchedule(raw: unknown): PaymentLockSchedule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const schedule: PaymentLockSchedule = {}
  const softFrom = validDayKey(source.softFrom)
  const hardFrom = validDayKey(source.hardFrom)
  if (softFrom) schedule.softFrom = softFrom
  if (hardFrom) schedule.hardFrom = hardFrom
  if (truthy(source.off)) schedule.off = true
  return schedule
}

/**
 * Стадия блокировки на календарный день `day`.
 *
 * ⚠ Жёсткая дата проверяется ПЕРВОЙ. Так правило не зависит от того, в каком порядке стоят даты в
 * окружении: перепутанные местами дают «жёстко с более ранней», а не тихую бессмыслицу. И каждая
 * дата работает в одиночку: только `softFrom` — напоминание без последующей блокировки, только
 * `hardFrom` — блокировка без предупреждения. Обе формы осмысленны, поэтому ни одна не требует
 * второй.
 */
export function paymentLockStage(day: string, schedule: PaymentLockSchedule): PaymentLockStage {
  if (schedule.off) return 'none'
  if (schedule.hardFrom && day >= schedule.hardFrom) return 'hard'
  if (schedule.softFrom && day >= schedule.softFrom) return 'soft'
  return 'none'
}

/**
 * Обход из адреса (`?lock=soft`, `?lock=hard`) — чтобы ПОСМОТРЕТЬ экран, не дожидаясь даты.
 *
 * ⛔ Понимаются только `soft` и `hard`. Значения «выключить» здесь нет и не будет: `?lock=none`
 * стал бы universal-ключом от блокировки, а такая ссылка расходится по переписке за минуту.
 * Снимают блокировку с сервера — переменной окружения, а не строкой в адресе.
 */
export function parseLockOverride(value: unknown): PaymentLockStage | undefined {
  if (Array.isArray(value)) {
    // Повторённый параметр (`?lock=soft&lock=hard`) — берём самый строгий, а не первый попавшийся.
    const stages = value.map(parseLockOverride).filter((stage): stage is PaymentLockStage => stage !== undefined)
    return stages.length ? stages.reduce(strongerStage) : undefined
  }
  return value === 'soft' || value === 'hard' ? value : undefined
}

/** Более строгая из двух стадий. */
export function strongerStage(a: PaymentLockStage, b: PaymentLockStage): PaymentLockStage {
  return STAGE_RANK[a] >= STAGE_RANK[b] ? a : b
}

/**
 * Итоговая стадия: расписание сервера ПЛЮС обход из адреса.
 *
 * ⚠ Только повышение. Обход существует ради показа экрана до даты; понизить им стадию — значит
 * отдать ключ от блокировки тому, кого она касается.
 */
export function effectiveStage(scheduled: PaymentLockStage, override: PaymentLockStage | undefined): PaymentLockStage {
  return override ? strongerStage(scheduled, override) : scheduled
}

/**
 * Стадия блокировки «здесь и сейчас»: расписание сервера, часы и обход из адреса вместе.
 *
 * ⚠ Собрано в ОДНУ функцию не для краткости. Порядок тут значащий — сначала календарный день,
 * потом расписание, потом повышение обходом, — и собранный по месту он разошёлся бы между
 * вызывающими. Разойтись двум таким местам нельзя: это разные ответы на вопрос «блокировать ли»,
 * причём оба правдоподобные.
 *
 * ⚠ `lockParam` — это `route.query.lock` РОУТЕРА, а не `window.location.search`. Разбор сырой
 * строки адреса здесь уже был и молча не работал: к моменту `onMounted` роутер успевает переписать
 * адрес, и `location.search` пуст — обход просто не срабатывал, а выглядело это как «блокировка
 * показывает не ту стадию». Поэтому тип `unknown`: у роутера значение бывает строкой, массивом
 * строк или отсутствует, и разбирает его та же проверяющая функция.
 */
export function lockStageFor(now: Date, schedule: PaymentLockSchedule, lockParam: unknown): PaymentLockStage {
  return effectiveStage(paymentLockStage(localDayKey(now), schedule), parseLockOverride(lockParam))
}

/**
 * Доля полосы обратного отсчёта, в процентах.
 *
 * ⚠ Живёт здесь, а не в шаблоне экрана, по общему правилу проекта: формула в компоненте не
 * покрыта тестом. Клэмп не «на всякий случай» — `remaining` приходит из таймера, и такт,
 * пришедший после снятия блокировки, дал бы отрицательную ширину, то есть полосу, уехавшую за
 * край карточки.
 */
export function lockProgressPercent(remaining: number, total = LOCK_RELEASE_SECONDS): number {
  if (!Number.isFinite(remaining) || total <= 0) return 0
  return Math.round(Math.min(1, Math.max(0, remaining / total)) * 100)
}

/**
 * Блокировка касается этой страницы.
 *
 * ⛔ `/install` НЕ блокируется никогда, и это не поблажка. Через него портал ставит и ПЕРЕставляет
 * приложение: заблокируй мы установщик — и починить что-либо на портале клиента станет нельзя, в
 * том числе снять саму блокировку. Публичная `/` тоже ни при чём: там нет ни отчётов, ни данных.
 */
export function lockAppliesTo(path: string): boolean {
  return path === '/app' || path.startsWith('/app/')
}

/**
 * «20 секунд», «3 секунды», «1 секунда» — русские склонения на отсчёте.
 *
 * ⚠ Отсчёт читают вслух глазами каждую секунду, и «осталось 2 секунд» — это первое, за что
 * цепляется взгляд: экран и так говорит неприятную вещь, добавлять к ней неряшливость не стоит.
 */
export function secondsLabel(seconds: number): string {
  const abs = Math.abs(Math.trunc(seconds))
  const tail = abs % 10
  const hundred = abs % 100
  if (hundred >= 11 && hundred <= 14) return `${abs} секунд`
  if (tail === 1) return `${abs} секунда`
  if (tail >= 2 && tail <= 4) return `${abs} секунды`
  return `${abs} секунд`
}
