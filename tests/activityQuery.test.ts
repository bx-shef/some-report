import { describe, expect, it } from 'vitest'
import type { ActivityFilters, ActivityUser } from '~/types/activity'
import { DEFAULT_CALL_THRESHOLD_SECONDS } from '~/types/activity'
import {
  CALL_TYPE_CODE,
  DEED_DIRECTION,
  DEED_TYPE_ID,
  activityCounterBatch,
  callDrillFilter,
  callListParams,
  deedFilter,
  leadCountFilter,
  overdueFilter
} from '~/utils/activityQuery'
import { deedKey, leadKey, overdueKey } from '~/utils/activityLoad'

/**
 * Запросы отчёта «Активность пользователей».
 *
 * ⚠ Ошибка в фильтре отчёт не роняет — она тихо меняет все числа. Поэтому проверяется не «функция
 * что-то вернула», а КАЖДОЕ условие поимённо: перепутанное направление, потерянная верхняя
 * граница периода и лишний день на краю выглядят на экране совершенно правдоподобно.
 */

const period = { from: '2026-08-01', to: '2026-08-31' }

function filters(over: Partial<ActivityFilters> = {}): ActivityFilters {
  return { period, thresholdSeconds: DEFAULT_CALL_THRESHOLD_SECONDS, ...over }
}

describe('DEED_TYPE_ID', () => {
  /**
   * ⛔ Звонка в списке нет намеренно: дела `VOXIMPLANT_CALL` (`TYPE_ID: 2`) — это те же записи,
   * что отдаёт телефония (август: 18 418 и там, и там). Посчитай отчёт и то, и другое — одни и те
   * же разговоры встали бы в таблицу дважды.
   */
  it('звонка среди видов дел нет', () => {
    expect(Object.values(DEED_TYPE_ID)).not.toContain(2)
    expect(DEED_TYPE_ID).toEqual({ meeting: 1, task: 3, email: 4 })
  })

  /**
   * ⛔ У дел CRM `1` — ВХОДЯЩЕЕ, а у телефонии `CALL_TYPE: 1` — ИСХОДЯЩИЙ. Две обратные шкалы в
   * одном отчёте: перепутать — поменять местами столбцы писем, и по числам этого не видно.
   */
  it('направление дела CRM обратно направлению звонка телефонии', () => {
    expect(DEED_DIRECTION).toEqual({ in: 1, out: 2 })
  })
})

describe('deedFilter', () => {
  it('спрашивает дела одного вида, направления и сотрудника за период', () => {
    expect(deedFilter(period, 7, 'email', 'out')).toEqual({
      '>=CREATED': '2026-08-01',
      '<CREATED': '2026-09-01',
      'RESPONSIBLE_ID': 7,
      'TYPE_ID': 4,
      'DIRECTION': 2
    })
  })

  /**
   * ⚠ Верхняя граница — начало СЛЕДУЮЩЕГО дня, а не конец периода. Портал сравнивает дату как
   * дату-время, и `<=CREATED: '2026-08-31'` молча выбросил бы весь последний день месяца.
   */
  it('верхняя граница исключающая, последний день периода не теряется', () => {
    expect(deedFilter(period, 7, 'meeting')['<CREATED']).toBe('2026-09-01')
    expect(deedFilter(period, 7, 'meeting')).not.toHaveProperty('<=CREATED')
  })

  /** ⚠ У встреч и задач портал ставит `DIRECTION: 0` всем записям — разрез был бы вечным нулём. */
  it('без направления условия о направлении нет вовсе', () => {
    expect(deedFilter(period, 7, 'meeting')).not.toHaveProperty('DIRECTION')
    expect(deedFilter(period, 7, 'task')).not.toHaveProperty('DIRECTION')
  })
})

describe('overdueFilter', () => {
  /**
   * ⚠ Правило прежнего отчёта: просрочка — состояние НА КОНЕЦ периода, а не событие внутри него.
   * Нижней границы тут быть не должно: дело со сроком трёхлетней давности — такой же висяк.
   */
  it('нижней границы периода нет: висяк остаётся висяком', () => {
    const filter = overdueFilter(period, 7)
    expect(filter).not.toHaveProperty('>=END_TIME')
    expect(filter).not.toHaveProperty('>=CREATED')
    expect(filter).toEqual({ 'RESPONSIBLE_ID': 7, 'COMPLETED': 'N', '<END_TIME': '2026-09-01' })
  })
})

describe('leadCountFilter', () => {
  /**
   * ⚠ Созданные считаются по дате СОЗДАНИЯ, закрытые — по дате ЗАКРЫТИЯ. Закрытый в августе лид
   * мог прийти в мае, и это работа августа: `created` и `won + lost` в одной строке сходиться НЕ
   * обязаны.
   */
  it('созданные — по дате создания, закрытые — по дате закрытия', () => {
    expect(leadCountFilter(period, 7, 'created')).toEqual({
      'ASSIGNED_BY_ID': 7,
      '>=DATE_CREATE': '2026-08-01',
      '<DATE_CREATE': '2026-09-01'
    })
    expect(leadCountFilter(period, 7, 'won')).toEqual({
      'ASSIGNED_BY_ID': 7,
      '>=DATE_CLOSED': '2026-08-01',
      '<DATE_CLOSED': '2026-09-01',
      'STATUS_SEMANTIC_ID': 'S'
    })
    expect(leadCountFilter(period, 7, 'lost').STATUS_SEMANTIC_ID).toBe('F')
  })

  /** ⚠ Семантика, а не список кодов: стадии заказчик переименовывает. */
  it('успех и провал берутся семантикой стадии', () => {
    expect(leadCountFilter(period, 7, 'created')).not.toHaveProperty('STATUS_SEMANTIC_ID')
    expect(leadCountFilter(period, 7, 'won')).not.toHaveProperty('STATUS_ID')
  })
})

describe('activityCounterBatch', () => {
  const users: ActivityUser[] = [{ id: 7, name: 'Иванов И.' }, { id: 8, name: 'Петров П.' }]

  it('восемь вопросов на сотрудника, и все под ключами ядра', () => {
    const batch = activityCounterBatch(users, filters())
    expect(Object.keys(batch)).toHaveLength(16)
    for (const id of [7, 8]) {
      expect(batch).toHaveProperty(deedKey(id, 'email', 'in'))
      expect(batch).toHaveProperty(deedKey(id, 'email', 'out'))
      expect(batch).toHaveProperty(deedKey(id, 'meeting'))
      expect(batch).toHaveProperty(deedKey(id, 'task'))
      expect(batch).toHaveProperty(overdueKey(id))
      expect(batch).toHaveProperty(leadKey(id, 'created'))
      expect(batch).toHaveProperty(leadKey(id, 'won'))
      expect(batch).toHaveProperty(leadKey(id, 'lost'))
    }
  })

  /**
   * ⚠ Ключи строит ЯДРО, и читает ответы тоже оно. Разъехавшись, карта вопросов и карта ответов
   * дали бы таблицу из нулей без единого признака поломки — портал-то отвечает исправно.
   */
  it('ключи команд — ровно те, по которым ядро читает ответы', () => {
    const batch = activityCounterBatch([{ id: 7, name: 'И' }], filters())
    expect(Object.keys(batch).sort()).toEqual([
      deedKey(7, 'email', 'in'),
      deedKey(7, 'email', 'out'),
      deedKey(7, 'meeting'),
      deedKey(7, 'task'),
      leadKey(7, 'created'),
      leadKey(7, 'lost'),
      leadKey(7, 'won'),
      overdueKey(7)
    ].sort())
  })

  /** Счётчик — это вопрос «сколько», а не выборка: ни одной строки данных он не тянет. */
  it('каждая команда — счётчик, а не чтение строк', () => {
    for (const command of Object.values(activityCounterBatch(users, filters()))) {
      expect(command.params.select).toEqual(['ID'])
      expect(command.params.start).toBe(0)
      expect(['crm.activity.list', 'crm.lead.list']).toContain(command.method)
    }
  })

  it('дела спрашиваются у дел, лиды — у лидов', () => {
    const batch = activityCounterBatch([{ id: 7, name: 'И' }], filters())
    expect(batch[deedKey(7, 'email', 'in')]?.method).toBe('crm.activity.list')
    expect(batch[overdueKey(7)]?.method).toBe('crm.activity.list')
    expect(batch[leadKey(7, 'won')]?.method).toBe('crm.lead.list')
  })

  it('пустой список сотрудников — ни одного вопроса порталу', () => {
    expect(activityCounterBatch([], filters())).toEqual({})
  })
})

describe('callListParams', () => {
  /**
   * ⛔ У `voximplant.statistic.get` СВОЯ конвенция: фильтр под ЗАГЛАВНЫМ ключом. Строчный `filter`
   * метод не понимает — он не отвергнет запрос, а вернёт весь портал за всё время.
   */
  it('фильтр под заглавным ключом, как требует метод телефонии', () => {
    const params = callListParams(period)
    expect(params).toHaveProperty('FILTER')
    expect(params).not.toHaveProperty('filter')
    expect(params.FILTER).toEqual({
      '>=CALL_START_DATE': '2026-08-01',
      '<CALL_START_DATE': '2026-09-01'
    })
  })

  /**
   * ⚠ Порог и код завершения в запрос НЕ кладутся, хотя портал их понимает: отчёт показывает
   * недозвоны и короткие разговоры отдельными числами, и отсеки мы их запросом — считать эти
   * показатели стало бы не из чего.
   */
  it('порог и код завершения остаются ядру, а не уезжают в фильтр', () => {
    const filter = callListParams(period).FILTER as Record<string, unknown>
    expect(filter).not.toHaveProperty('CALL_FAILED_CODE')
    expect(filter).not.toHaveProperty('>CALL_DURATION')
    expect(filter).not.toHaveProperty('CALL_DURATION')
  })

  it('листается смещением, начиная с нуля', () => {
    expect(callListParams(period).start).toBe(0)
    expect(callListParams(period, 150).start).toBe(150)
  })
})

describe('callDrillFilter', () => {
  /**
   * ⛔ Это единственное место, где правило ядра переписано на язык REST, и точность здесь
   * проверена замером боевого портала за август: `CALL_FAILED_CODE: '200'` → 12 375, обратное
   * условие → 6 640 (в сумме 19 015 — все звонки), `>CALL_DURATION: 29` → 10 404, `<=` → 1 971
   * (в сумме 12 375), по направлениям 5 661 + 4 743 = 10 404. Разойдись перевод хоть в одном
   * условии — под числом отчёта открылся бы список другой длины.
   */
  it('разговоры: состоялся и ДОЛЬШЕ порога', () => {
    expect(callDrillFilter(period, 'talks', 29, { userId: 7 })).toEqual({
      '>=CALL_START_DATE': '2026-08-01',
      '<CALL_START_DATE': '2026-09-01',
      'PORTAL_USER_ID': 7,
      'CALL_FAILED_CODE': '200',
      '>CALL_DURATION': 29
    })
  })

  it('недозвоны — отрицание кода, без порога вовсе', () => {
    const filter = callDrillFilter(period, 'failed', 29, { userId: 7 })
    expect(filter['!CALL_FAILED_CODE']).toBe('200')
    expect(filter).not.toHaveProperty('CALL_FAILED_CODE')
    expect(filter).not.toHaveProperty('>CALL_DURATION')
    expect(filter).not.toHaveProperty('<=CALL_DURATION')
  })

  it('короткие — состоялся, но НЕ дольше порога', () => {
    const filter = callDrillFilter(period, 'tooShort', 29, { userId: 7 })
    expect(filter.CALL_FAILED_CODE).toBe('200')
    expect(filter['<=CALL_DURATION']).toBe(29)
    expect(filter).not.toHaveProperty('>CALL_DURATION')
  })

  /**
   * ⛔ У телефонии `CALL_TYPE: 1` — ИСХОДЯЩИЙ, а у дел CRM `DIRECTION: 1` — входящее. Две обратные
   * шкалы в одном отчёте: перепутать — открыть под числом входящих список исходящих, и по длине
   * списка это НЕ видно, оба правдоподобны.
   */
  it('направление звонка обратно направлению дела CRM', () => {
    expect(CALL_TYPE_CODE).toEqual({ out: 1, in: 2 })
    expect(callDrillFilter(period, 'talks', 29, { direction: 'out' }).CALL_TYPE).toBe(1)
    expect(callDrillFilter(period, 'talks', 29, { direction: 'in' }).CALL_TYPE).toBe(2)
    // Та же пара у дел CRM — ровно наоборот.
    expect(DEED_DIRECTION.out).toBe(2)
    expect(DEED_DIRECTION.in).toBe(1)
  })

  /**
   * ⚠ Ядро направление недозвонов и коротких не считает, столбца такого на экране нет — и в
   * фильтре его быть не должно: список оказался бы короче числа над ним.
   */
  it('у недозвонов и коротких направления в условии нет', () => {
    expect(callDrillFilter(period, 'failed', 29, { userId: 7, direction: 'in' })).not.toHaveProperty('CALL_TYPE')
    expect(callDrillFilter(period, 'tooShort', 29, { userId: 7, direction: 'in' })).not.toHaveProperty('CALL_TYPE')
  })

  /**
   * ⚠ `userId: 0` — это «звонок без сотрудника», ЗНАЧЕНИЕ фильтра. Привычное `userId ? …` молча
   * превратило бы строку «Без сотрудника» во «все звонки портала».
   */
  it('нулевой сотрудник — условие, а не его отсутствие', () => {
    expect(callDrillFilter(period, 'failed', 29, { userId: 0 }).PORTAL_USER_ID).toBe(0)
    expect(callDrillFilter(period, 'failed', 29)).not.toHaveProperty('PORTAL_USER_ID')
  })

  it('порог берётся из отбора, а не из умолчания', () => {
    expect(callDrillFilter(period, 'talks', 120)['>CALL_DURATION']).toBe(120)
  })
})
