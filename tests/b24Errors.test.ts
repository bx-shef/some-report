import { describe, expect, it } from 'vitest'
import { errorCode, hasRateLimit, isRateLimit, RATE_LIMIT_CODE, RATE_LIMIT_MESSAGE, retryDelayMs } from '~/utils/b24Errors'

/**
 * Отличать отказ по интенсивности от остальных приходится по КОДУ.
 *
 * ⚠ Цена ошибки несимметрична. Принять чужой отказ за лимит — заставить человека ждать три
 * секунды и получить ту же ошибку («нет права» повтором не лечится). Не узнать лимит — потерять
 * весь пакет и показать «не удалось прочитать данные портала» там, где хватило бы паузы.
 */

describe('код ошибки портала', () => {
  it('достаётся у ошибки SDK', () => {
    expect(errorCode({ code: RATE_LIMIT_CODE })).toBe(RATE_LIMIT_CODE)
    expect(errorCode(Object.assign(new Error('slow down'), { code: RATE_LIMIT_CODE }))).toBe(RATE_LIMIT_CODE)
  })

  // ⚠ Слепое приведение объявило бы кодом что угодно — и повтор ушёл бы в ошибку, которую
  // повторять бессмысленно.
  it('не выдумывается там, где его нет', () => {
    for (const value of [undefined, null, 'QUERY_LIMIT_EXCEEDED', 42, new Error('нет права'), {}, { code: '' }, { code: 503 }]) {
      expect(errorCode(value)).toBeUndefined()
    }
  })
})

describe('отказ по интенсивности', () => {
  it('узнаётся по коду', () => {
    expect(isRateLimit({ code: RATE_LIMIT_CODE })).toBe(true)
  })

  /**
   * ⚠ ТОЛЬКО по коду. Текст портал отдаёт на своём языке и меняет между версиями: узнавать лимит
   * по словам «превышена интенсивность» значит перестать его узнавать на англоязычном портале.
   */
  it('не узнаётся по тексту сообщения', () => {
    expect(isRateLimit(new Error('Превышена интенсивность HTTP-запросов к Битрикс24'))).toBe(false)
    expect(isRateLimit({ message: RATE_LIMIT_CODE })).toBe(false)
  })

  it('чужие отказы за лимит не принимаются', () => {
    for (const code of ['AUTHORIZE_ERROR', 'INSUFFICIENT_SCOPE', 'ERROR_BATCH_LENGTH_EXCEEDED', 'OPERATION_TIME_LIMIT']) {
      expect(isRateLimit({ code })).toBe(false)
    }
  })
})

describe('ошибки пакета по ключам команд', () => {
  // Одна упёршаяся команда делает неуспешным ВЕСЬ пакет — значит и решение принимается по всему.
  it('лимит хотя бы у одной команды — повод повторить пакет', () => {
    expect(hasRateLimit({ p3: { code: RATE_LIMIT_CODE } })).toBe(true)
    expect(hasRateLimit({ p1: { code: 'AUTHORIZE_ERROR' }, p7: { code: RATE_LIMIT_CODE } })).toBe(true)
  })

  it('пакет без лимита не повторяется', () => {
    expect(hasRateLimit({})).toBe(false)
    expect(hasRateLimit({ 'p1': new Error('нет права'), 'base-error': { code: 'AUTHORIZE_ERROR' } })).toBe(false)
  })
})

describe('что читает человек', () => {
  // ⚠ «Не удалось прочитать данные портала» — неправда: данные читаются, портал просит реже.
  it('сообщение говорит про частоту, а не про сбой', () => {
    expect(RATE_LIMIT_MESSAGE).toContain('частоту запросов')
    expect(RATE_LIMIT_MESSAGE).not.toContain('Не удалось')
    // И говорит, ЧТО делать: иначе человек идёт в поддержку вместо того, чтобы подождать.
    expect(RATE_LIMIT_MESSAGE).toMatch(/Подождите|подождите/)
  })
})

describe('пауза перед повтором', () => {
  /**
   * ⛔ Без разброса все клиенты, упёршиеся в лимит одновременно, повторят В ОДИН МОМЕНТ — и
   * вместо того, чтобы разойтись во времени, постучатся в портал хором. Документация платформы
   * прямо просит «не пускать параллельные серии с одного адреса».
   */
  it('одна и та же база даёт РАЗНЫЕ паузы', () => {
    const delays = [0, 0.25, 0.5, 0.75, 1].map(random => retryDelayMs(1000, 0.3, random))
    expect(new Set(delays).size).toBeGreaterThan(1)
  })

  it('разброс держится в заданных границах', () => {
    for (const random of [0, 0.1, 0.5, 0.9, 1]) {
      const delay = retryDelayMs(1000, 0.3, random)
      expect(delay).toBeGreaterThanOrEqual(700)
      expect(delay).toBeLessThanOrEqual(1300)
    }
    // Края — ровно ±30 %, а не «примерно».
    expect(retryDelayMs(1000, 0.3, 0)).toBe(700)
    expect(retryDelayMs(1000, 0.3, 1)).toBe(1300)
    expect(retryDelayMs(1000, 0.3, 0.5)).toBe(1000)
  })

  // ⚠ Отрицательная пауза означала бы повтор без паузы вовсе — то есть удар по порталу сразу
  // после того, как он попросил подождать.
  it('никогда не отрицательная', () => {
    expect(retryDelayMs(1000, 3, 0)).toBe(0)
    expect(retryDelayMs(0, 0.3, 0)).toBe(0)
  })
})
