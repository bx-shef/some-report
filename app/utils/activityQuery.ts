import type { ActivityFilters, ActivityUser, CallDirection, DeedKind } from '~/types/activity'
import type { DrillFilter } from '~/utils/drillSlider'
import { CALL_SUCCESS_CODE } from '~/types/activity'
import type { ReportPeriod } from '~/types/report'
import type { BatchCommand } from '~/utils/b24Query'
import { countCommand, nextDay, periodFilter } from '~/utils/b24Query'
import { deedKey, leadKey, overdueKey } from '~/utils/activityLoad'

/**
 * Запросы отчёта «Активность пользователей»: что именно спрашиваем у портала.
 *
 * Дела и лиды — ВОПРОСАМИ «сколько», по одному на клетку, пакетами по 50: замер боевого портала
 * даёт 0,38 с на пакет из 50 счётчиков, то есть весь отдел считается быстрее секунды. Звонки —
 * строками и фоном, потому что сумму длительности `total` не даёт вовсе
 * ([`docs/PORTAL.md`](../../docs/PORTAL.md)).
 *
 * Модуль чистый и потому под тестом: ошибка в фильтре не роняет отчёт, а тихо меняет все числа.
 */

/** Ответственный за дело — у дел CRM поле называется иначе, чем у сделок. */
export const DEED_RESPONSIBLE_FIELD = 'RESPONSIBLE_ID'

/**
 * Код вида дела в портале (`TYPE_ID`).
 *
 * ⛔ Звонка (`2`) здесь нет намеренно: дела `VOXIMPLANT_CALL` — это те же записи, что отдаёт
 * телефония, и счёт по ним удвоил бы разговоры в таблице (`app/types/activity.ts`, `DeedKind`).
 */
export const DEED_TYPE_ID: Record<DeedKind, number> = {
  meeting: 1,
  task: 3,
  email: 4
}

/**
 * Код направления дела CRM (`DIRECTION`).
 *
 * ⛔ Здесь `1` — ВХОДЯЩЕЕ, `2` — ИСХОДЯЩЕЕ, то есть НАОБОРОТ к `CALL_TYPE` телефонии. Это не
 * описка и не наша вольность: значения взяты у портала (`crm.enum.activitydirection`) и сверены
 * поимённо на 38 звонках — `CALL_TYPE: 1` соответствует `DIRECTION: 2`
 * ([`docs/PORTAL.md`](../../docs/PORTAL.md), «Телефония»). Две шкалы в одном отчёте — источник
 * ровно той ошибки, которую по числам не видно, поэтому перевод между ними живёт в одном месте:
 * здесь.
 */
export const DEED_DIRECTION: Record<CallDirection, number> = {
  in: 1,
  out: 2
}

/** Фильтр дел одного сотрудника за период. Дела берутся по дате СОЗДАНИЯ. */
export function deedFilter(
  period: ReportPeriod,
  userId: number,
  kind: DeedKind,
  direction?: CallDirection
): DrillFilter {
  return {
    ...periodFilter(period, 'CREATED'),
    [DEED_RESPONSIBLE_FIELD]: userId,
    TYPE_ID: DEED_TYPE_ID[kind],
    ...(direction ? { DIRECTION: DEED_DIRECTION[direction] } : {})
  }
}

/**
 * Фильтр просроченных дел сотрудника.
 *
 * ⚠ Нижней границы периода тут НЕТ, и это правило прежнего отчёта, а не упущение: просрочка —
 * состояние НА КОНЕЦ периода, а не событие внутри него. Дело со сроком трёхлетней давности,
 * которое так и не выполнили, — такой же висяк, как вчерашнее.
 *
 * ⚠ Граница берётся `<=` по концу периода, а не `<` по следующему дню, как у остальных фильтров:
 * `periodFilter` спрашивает «создано В периоде», а здесь вопрос другой — «срок истёк К этому
 * моменту».
 */
export function overdueFilter(period: ReportPeriod, userId: number): DrillFilter {
  return {
    [DEED_RESPONSIBLE_FIELD]: userId,
    'COMPLETED': 'N',
    // ⚠ Граница — начало СЛЕДУЮЩЕГО дня, а не конец периода: портал сравнивает `END_TIME` как
    // дату-время, и `<=END_TIME: '2026-08-31'` означало бы «до полуночи 31-го», выбрасывая
    // просроченные дела последних суток.
    '<END_TIME': nextDay(period.to)
  }
}

/**
 * Фильтр лидов сотрудника.
 *
 * ⚠ `created` считается по дате СОЗДАНИЯ, а `won`/`lost` — по дате ЗАКРЫТИЯ: закрытый в августе
 * лид мог прийти в мае, и это работа августа. Поэтому в одной строке `created` и `won + lost` не
 * обязаны сходиться — это разные вопросы.
 *
 * ⚠ Успех и провал берутся по СЕМАНТИКЕ стадии (`STATUS_SEMANTIC_ID`), а не по списку кодов:
 * стадии заказчик переименовывает, и зашитый список молча посчитал бы чужую воронку — то же
 * правило, что во всём проекте.
 */
export function leadCountFilter(
  period: ReportPeriod,
  userId: number,
  outcome: 'created' | 'won' | 'lost'
): DrillFilter {
  const assigned = { ASSIGNED_BY_ID: userId }
  if (outcome === 'created') return { ...assigned, ...periodFilter(period) }
  return {
    ...assigned,
    ...periodFilter(period, 'DATE_CLOSED'),
    STATUS_SEMANTIC_ID: outcome === 'won' ? 'S' : 'F'
  }
}

/**
 * Все вопросы «сколько» отчёта — по восемь на сотрудника.
 *
 * Письма спрашиваются двумя вопросами (входящие и исходящие), встречи и задачи — одним: у них
 * портал ставит `DIRECTION: 0` всем записям, и разрез был бы двумя вечными нулями.
 *
 * ⚠ Пакет режет на полсотни `useB24Batch`, а не этот модуль: 92 сотрудника дают 736 команд, и
 * знать про предел портала должно одно место на все отчёты.
 */
export function activityCounterBatch(
  users: readonly ActivityUser[],
  filters: ActivityFilters
): Record<string, BatchCommand> {
  const commands: Record<string, BatchCommand> = {}
  const period = filters.period
  for (const user of users) {
    for (const direction of ['in', 'out'] as const) {
      commands[deedKey(user.id, 'email', direction)]
        = countCommand('crm.activity.list', deedFilter(period, user.id, 'email', direction))
    }
    for (const kind of ['meeting', 'task'] as const) {
      commands[deedKey(user.id, kind)]
        = countCommand('crm.activity.list', deedFilter(period, user.id, kind))
    }
    commands[overdueKey(user.id)]
      = countCommand('crm.activity.list', overdueFilter(period, user.id))
    for (const outcome of ['created', 'won', 'lost'] as const) {
      commands[leadKey(user.id, outcome)]
        = countCommand('crm.lead.list', leadCountFilter(period, user.id, outcome))
    }
  }
  return commands
}

/**
 * Какая часть звонков стоит за числом отчёта — то же деление, что делает ядро.
 *
 * - `talks` — состоявшиеся разговоры ДОЛЬШЕ порога (можно с направлением);
 * - `failed` — набрали номер, но разговора не вышло;
 * - `tooShort` — дозвонились, но разговор не дольше порога.
 */
export type CallPart = 'talks' | 'failed' | 'tooShort'

/**
 * Фильтр списка звонков за одним числом отчёта.
 *
 * ⛔ Это ЕДИНСТВЕННОЕ место, где правило порога переписано на язык REST, — само оно живёт в ядре
 * (`aggregateCalls`). Замер боевого портала за август подтверждает, что перевод точен, и это не
 * «похоже»: `CALL_FAILED_CODE: '200'` даёт 12 375, обратное условие — 6 640 (в сумме 19 015 —
 * все звонки), `>CALL_DURATION: 29` даёт 10 404, `<=` — 1 971 (в сумме 12 375), а по направлениям
 * 5 661 + 4 743 = 10 404. Разойдись это хоть в одном условии — под числом отчёта открылся бы
 * список другой длины, и правило проекта требует тогда НЕ делать число кликабельным вовсе.
 *
 * ⚠ Направление у `talks` необязательно, а у `failed` и `tooShort` его НЕТ вовсе — и это не
 * упущение: ядро направление недозвонов и коротких не считает, и столбца такого на экране нет.
 * Добавить его в фильтр значило бы показать список короче числа над ним.
 *
 * ⚠ Порог сравнивается СТРОГО (`>`), как в ядре и в прежнем отчёте заказчика: разговор ровно в
 * порог — короткий. Сдвиг на секунду развёл бы список с числом ровно на границе.
 */
export function callDrillFilter(
  period: ReportPeriod,
  part: CallPart,
  thresholdSeconds: number,
  options: { userId?: number, direction?: CallDirection } = {}
): DrillFilter {
  // ⚠ Тип НЕ `Record<string, unknown>`, а `DrillFilter`, и это не педантизм: условие уезжает в
  // слайдер через портал и разбирается там проверяюще. Положи сюда булево или вложенный объект —
  // компилятор промолчал бы, а `readDrillPayload` на том конце отверг бы нагрузку целиком, и
  // человек получил бы «список не открылся» при исправном отчёте.
  const base: DrillFilter = {
    ...periodFilter(period, 'CALL_START_DATE'),
    // ⚠ `userId: 0` — это «звонок без сотрудника», ЗНАЧЕНИЕ, а не «фильтра нет»: привычное
    // `options.userId ? …` молча превратило бы эту строку во «все звонки портала».
    ...(options.userId === undefined ? {} : { PORTAL_USER_ID: options.userId })
  }
  if (part === 'failed') return { ...base, [`!${CALL_SUCCESS_FIELD}`]: CALL_SUCCESS_CODE }
  const answered = { ...base, [CALL_SUCCESS_FIELD]: CALL_SUCCESS_CODE }
  if (part === 'tooShort') return { ...answered, '<=CALL_DURATION': thresholdSeconds }
  return {
    ...answered,
    '>CALL_DURATION': thresholdSeconds,
    ...(options.direction ? { CALL_TYPE: CALL_TYPE_CODE[options.direction] } : {})
  }
}

/** Поле кода завершения звонка. */
const CALL_SUCCESS_FIELD = 'CALL_FAILED_CODE'

/**
 * Направление звонка кодом портала — обратный перевод к `callDirection` ядра.
 *
 * ⛔ `1` — ИСХОДЯЩИЙ, `2` — ВХОДЯЩИЙ, то есть НАОБОРОТ к `DEED_DIRECTION` дел CRM. Две обратные
 * шкалы в одном отчёте: обе живут рядом намеренно, чтобы разница была видна глазом.
 */
export const CALL_TYPE_CODE: Record<CallDirection, number> = {
  out: 1,
  in: 2
}

/**
 * Команды пакета для страниц звонков.
 *
 * ⛔ Пакетом, а не одиночными запросами, и это ИСПРАВЛЕНИЕ прежнего вывода. В первой редакции
 * отчёта здесь стояли одиночные запросы по восемь разом, со ссылкой на замер «пакет не ускоряет:
 * портал выполняет команды пакета последовательно». Замер был неверен. Перемер 2026-09-06:
 *
 * | способ | мс на страницу |
 * |---|---|
 * | 8 одиночных запросов разом | 124 |
 * | 1 пакет из 50 команд | 24 |
 * | 4 пакета по 50 разом | 11 |
 *
 * Весь август (19 015 звонков, 381 страница) пакетами — **5,7 секунды и 8 HTTP-запросов**, все
 * строки, ноль ошибок. Одиночными это были бы минуты. Внутри пакета команды и правда идут одна за
 * другой, но круг по сети экономится на каждой из пятидесяти — вот этого прежний вывод и не учёл.
 *
 * ⚠ Ключ команды — `c<номер страницы>`: ответы пакета приходят объектом, и порядок в нём не
 * гарантирован. Сортировать по ключу нельзя — надо разбирать номер (`callPageOfKey`).
 */
export function callPageCommands(
  period: ReportPeriod,
  fromPage: number,
  count: number,
  pageSize: number
): Record<string, BatchCommand> {
  const commands: Record<string, BatchCommand> = {}
  for (let index = 0; index < count; index++) {
    const page = fromPage + index
    commands[`c${page}`] = {
      method: 'voximplant.statistic.get',
      params: callListParams(period, page * pageSize)
    }
  }
  return commands
}

/** Номер страницы из ключа команды — ответы пакета приходят объектом, порядок не гарантирован. */
export function callPageOfKey(key: string): number {
  const digits = key.startsWith('c') ? key.slice(1) : ''
  // ⚠ Пустой хвост — отдельно: `Number('')` это НОЛЬ, и ключ `'c'` без номера прочитался бы
  // страницей 0. Сегодня такой ключ не строится, но чинится это одной строкой, а ловится —
  // только чужими звонками под верным заголовком.
  if (digits === '') return -1
  const page = Number(digits)
  return Number.isInteger(page) && page >= 0 ? page : -1
}

/**
 * Параметры выборки звонков за период.
 *
 * ⛔ Ключ фильтра — ЗАГЛАВНЫЙ `FILTER`, а не строчный: у `voximplant.statistic.get` своя
 * конвенция, отличная от методов CRM. И читается эта выборка ОДИНОЧНЫМИ вызовами с `start`, а не
 * через `callList`: тот дописывает курсор `'>ID'` в СТРОЧНЫЙ `filter`, которого этот метод не
 * понимает, — условие уехало бы мимо, и отчёт прочитал бы весь портал за всё время.
 *
 * ⚠ Порог и код завершения в фильтр НЕ кладутся, хотя портал их понимает. Отчёт показывает и
 * недозвоны, и короткие разговоры отдельными числами — отсеки мы их запросом, эти показатели
 * стало бы не из чего считать. Правило применяет ядро (`aggregateCalls`).
 */
export function callListParams(period: ReportPeriod, start = 0): Record<string, unknown> {
  return {
    // ⚠ Границы строит `periodFilter` — та же функция, что у остальных выборок отчёта. Своя копия
    // здесь однажды разошлась бы с ней в том, включён ли последний день периода, и тогда звонки
    // считались бы за один месяц, а дела и лиды — за слегка другой.
    FILTER: periodFilter(period, 'CALL_START_DATE'),
    SORT: 'CALL_START_DATE',
    ORDER: 'ASC',
    start
  }
}
