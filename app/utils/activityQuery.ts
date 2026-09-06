import type { ActivityFilters, ActivityUser, CallDirection, DeedKind } from '~/types/activity'
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
): Record<string, unknown> {
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
export function overdueFilter(period: ReportPeriod, userId: number): Record<string, unknown> {
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
): Record<string, unknown> {
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
 * знать про предел портала должно одно место на оба отчёта.
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
    // здесь однажды разошлась бы с ней в том, включён ли последний день периода, и два отчёта
    // считали бы один месяц по-разному.
    FILTER: periodFilter(period, 'CALL_START_DATE'),
    SORT: 'CALL_START_DATE',
    ORDER: 'ASC',
    start
  }
}
