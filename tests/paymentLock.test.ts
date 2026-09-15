import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  effectiveStage,
  lockAppliesTo,
  localDayKey,
  parseLockOverride,
  parseLockSchedule,
  paymentLockStage,
  secondsLabel,
  strongerStage
} from '~/utils/paymentLock'

/**
 * Блокировка приложения при неподписанных актах.
 *
 * ⚠ Проверяется здесь ровно то, чего нельзя увидеть глазами на экране: границы дней, разбор
 * настроек сервера и правило «обход только повышает». Ошибка в любом из трёх выглядит одинаково —
 * приложение ведёт себя не в тот день, — и замечает её клиент, а не мы.
 */
describe('localDayKey: календарный день по МЕСТНОМУ времени', () => {
  const original = process.env.TZ

  // ⚠ Часовой пояс задаётся явно, потому что иначе проверка ничего не доказывала бы: на CI машина
  // живёт в UTC, и «местный день» там совпадает с UTC случайно, а не по устройству функции.
  beforeAll(() => {
    process.env.TZ = 'Europe/Minsk'
  })
  afterAll(() => {
    process.env.TZ = original
  })

  /**
   * ⛔ Главная проверка модуля. Портал заказчика живёт в UTC+3: в полночь 18-го по Минску в UTC
   * ещё 17-е. Считай мы день по UTC — обещанное «с 17 сентября» включалось бы в три часа ночи
   * 18-го, то есть на сутки позже, чем сказано в переписке.
   */
  it('после полуночи по Минску день уже НОВЫЙ, хотя по UTC ещё старый', () => {
    const justAfterMidnightInMinsk = new Date('2026-09-17T22:30:00Z')
    expect(justAfterMidnightInMinsk.toISOString().slice(0, 10)).toBe('2026-09-17')
    expect(localDayKey(justAfterMidnightInMinsk)).toBe('2026-09-18')
  })

  it('день и месяц всегда двузначные — иначе сравнение строк развалится', () => {
    expect(localDayKey(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
    expect(localDayKey(new Date(2026, 11, 31, 12))).toBe('2026-12-31')
  })
})

describe('parseLockSchedule: настройки сервера разбираются проверяюще', () => {
  it('годное расписание доезжает целиком', () => {
    expect(parseLockSchedule({ softFrom: '2026-09-17', hardFrom: '2026-09-21', off: '' }))
      .toEqual({ softFrom: '2026-09-17', hardFrom: '2026-09-21' })
  })

  /**
   * ⚠ Пустые значения — ШТАТНОЕ состояние образа: даты живут только в окружении сервера, и в
   * свежем контейнере их нет. Пустой ответ обязан означать «блокировки нет», а не «что-то
   * сломалось».
   */
  it('пустые значения — это «блокировки нет», а не ошибка', () => {
    expect(parseLockSchedule({ softFrom: '', hardFrom: '', off: '' })).toEqual({})
    expect(parseLockSchedule({})).toEqual({})
  })

  /**
   * ⛔ Ошибка обязана уводить В СТОРОНУ РАБОТАЮЩЕГО отчёта. Запереть оплатившего клиента из-за
   * своей же опечатки в переменной окружения хуже, чем не показать напоминание.
   */
  it('мусор вместо настроек не включает блокировку', () => {
    for (const raw of [null, undefined, 'что-то', 42, [], ['2026-09-17']]) {
      expect(parseLockSchedule(raw)).toEqual({})
    }
  })

  /**
   * ⚠ `new Date('2026-02-31')` не бросает, а молча даёт 3 марта: без round-trip'а опечатка в
   * окружении включила бы блокировку на другой день, и никто бы не понял почему.
   */
  it('несуществующая дата отбрасывается, а не «понимается как сможем»', () => {
    expect(parseLockSchedule({ softFrom: '2026-02-31' })).toEqual({})
    expect(parseLockSchedule({ softFrom: '2026-13-01' })).toEqual({})
    expect(parseLockSchedule({ softFrom: '17.09.2026' })).toEqual({})
    expect(parseLockSchedule({ softFrom: '2026-9-7' })).toEqual({})
  })

  it('рубильник понимает явные «да» и не понимает всё остальное', () => {
    for (const off of ['1', 'true', 'YES', ' on ', true]) {
      expect(parseLockSchedule({ softFrom: '2026-09-17', off }).off).toBe(true)
    }
    for (const off of ['0', 'false', 'нет', '', 0, null, 'ok']) {
      expect(parseLockSchedule({ softFrom: '2026-09-17', off }).off).toBeUndefined()
    }
  })
})

describe('paymentLockStage: границы дней', () => {
  const schedule = { softFrom: '2026-09-17', hardFrom: '2026-09-21' }

  /** ⛔ Ровно та граница, о которой договорились: 16-го ещё пусто, 17-го уже экран с отсчётом. */
  it('накануне — ничего, в первый день — мягкая стадия', () => {
    expect(paymentLockStage('2026-09-16', schedule)).toBe('none')
    expect(paymentLockStage('2026-09-17', schedule)).toBe('soft')
  })

  /** ⛔ «После 20-го» — это 21-е: 20-е ещё с отсчётом, 21-е уже без него. */
  it('последний день отсчёта и первый день без него', () => {
    expect(paymentLockStage('2026-09-20', schedule)).toBe('soft')
    expect(paymentLockStage('2026-09-21', schedule)).toBe('hard')
    expect(paymentLockStage('2027-01-01', schedule)).toBe('hard')
  })

  /** Рубильник сильнее любых дат: он для того и заведён, чтобы снять блокировку одним движением. */
  it('рубильник снимает блокировку при любых датах', () => {
    expect(paymentLockStage('2027-01-01', { ...schedule, off: true })).toBe('none')
  })

  /** Каждая дата осмысленна в одиночку: напоминание без блокировки и блокировка без напоминания. */
  it('одной даты достаточно', () => {
    expect(paymentLockStage('2026-09-30', { softFrom: '2026-09-17' })).toBe('soft')
    expect(paymentLockStage('2026-09-30', { hardFrom: '2026-09-21' })).toBe('hard')
    expect(paymentLockStage('2026-09-30', {})).toBe('none')
  })

  /**
   * ⚠ Перепутанные местами даты дают «жёстко с более ранней», а не тихую бессмыслицу: жёсткая
   * проверяется первой именно поэтому.
   */
  it('перепутанные даты не превращаются в неопределённое поведение', () => {
    const swapped = { softFrom: '2026-09-21', hardFrom: '2026-09-17' }
    expect(paymentLockStage('2026-09-16', swapped)).toBe('none')
    expect(paymentLockStage('2026-09-18', swapped)).toBe('hard')
    expect(paymentLockStage('2026-09-22', swapped)).toBe('hard')
  })
})

describe('обход из адреса', () => {
  it('понимает soft и hard', () => {
    expect(parseLockOverride('soft')).toBe('soft')
    expect(parseLockOverride('hard')).toBe('hard')
  })

  /**
   * ⛔ Самое важное про обход: снять им блокировку нельзя. `?lock=none` стал бы ключом от неё, а
   * такая ссылка расходится по переписке за минуту.
   */
  it('снять блокировку адресом нельзя', () => {
    for (const value of ['none', 'off', '0', '', 'SOFT', undefined, null, 1]) {
      expect(parseLockOverride(value)).toBeUndefined()
    }
    expect(effectiveStage('hard', parseLockOverride('soft'))).toBe('hard')
    expect(effectiveStage('soft', undefined)).toBe('soft')
  })

  /** ⚠ Ради показа экрана до даты обход обязан ПОВЫШАТЬ — иначе завтрашний просмотр невозможен. */
  it('повышает стадию: экран видно до наступления даты', () => {
    expect(effectiveStage('none', parseLockOverride('soft'))).toBe('soft')
    expect(effectiveStage('none', parseLockOverride('hard'))).toBe('hard')
    expect(effectiveStage('soft', parseLockOverride('hard'))).toBe('hard')
  })

  it('повторённый параметр берёт самый строгий', () => {
    expect(parseLockOverride(['soft', 'hard'])).toBe('hard')
    expect(parseLockOverride(['hard', 'soft'])).toBe('hard')
    expect(parseLockOverride(['none', 'мусор'])).toBeUndefined()
  })

  it('strongerStage не зависит от порядка', () => {
    expect(strongerStage('none', 'soft')).toBe('soft')
    expect(strongerStage('soft', 'none')).toBe('soft')
    expect(strongerStage('hard', 'soft')).toBe('hard')
  })
})

describe('область действия блокировки', () => {
  it('отчёты и главная приложения блокируются', () => {
    expect(lockAppliesTo('/app')).toBe(true)
    expect(lockAppliesTo('/app/leads')).toBe(true)
    expect(lockAppliesTo('/app/managers')).toBe(true)
    expect(lockAppliesTo('/app/activity')).toBe(true)
  })

  /**
   * ⛔ Установщик не блокируется никогда: через него портал ставит и ПЕРЕставляет приложение.
   * Заблокируй мы его — чинить на портале клиента станет нечем, в том числе снимать саму
   * блокировку.
   */
  it('установщик и публичная страница не блокируются', () => {
    expect(lockAppliesTo('/install')).toBe(false)
    expect(lockAppliesTo('/')).toBe(false)
  })

  /** ⚠ Проверка по префиксу, а не по первым четырём буквам: посторонний путь мимо не проходит. */
  it('похожий путь блокировкой не считается', () => {
    expect(lockAppliesTo('/application')).toBe(false)
    expect(lockAppliesTo('/apps/leads')).toBe(false)
  })
})

describe('secondsLabel: склонения на отсчёте', () => {
  it('единственное, множественное и родительный падеж', () => {
    expect(secondsLabel(1)).toBe('1 секунда')
    expect(secondsLabel(2)).toBe('2 секунды')
    expect(secondsLabel(4)).toBe('4 секунды')
    expect(secondsLabel(5)).toBe('5 секунд')
    expect(secondsLabel(20)).toBe('20 секунд')
    expect(secondsLabel(21)).toBe('21 секунда')
    expect(secondsLabel(0)).toBe('0 секунд')
  })

  /** ⚠ Одиннадцать–четырнадцать — исключение русского языка, а не общее правило по последней цифре. */
  it('одиннадцать–четырнадцать не становятся «11 секунда»', () => {
    expect(secondsLabel(11)).toBe('11 секунд')
    expect(secondsLabel(12)).toBe('12 секунд')
    expect(secondsLabel(14)).toBe('14 секунд')
  })
})
