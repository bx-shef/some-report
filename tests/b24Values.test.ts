import { describe, expect, it } from 'vitest'
import { toNumber } from '~/utils/b24Values'

/**
 * Приведение сырых значений портала.
 *
 * ⚠ Ноль вместо `NaN` — не придирка: один `NaN` превращает в `NaN` всю сумму, в которую
 * попал, и на экране это «NaN» без единого указания, какая строка портала его дала.
 */
describe('toNumber', () => {
  it.each([
    ['строка от REST', '37', 37],
    ['дробная строка', '10300.50', 10300.5],
    ['число', 42, 42],
    ['null', null, 0],
    ['undefined', undefined, 0],
    ['пустая строка', '', 0],
    ['мусор', 'не число', 0],
    ['NaN', Number.NaN, 0],
    // ⚠ Классическая ловушка JS: `Number(['5']) === 5`, `Number([]) === 0`. Защита держится на
    // проверке `typeof value === 'string'`; «упрощение» до `Number(value) || 0` протащило бы
    // массив из REST как число, и тест обязан это ловить.
    ['массив', ['5'], 0],
    ['пустой массив', [], 0],
    ['объект', {}, 0],
    ['boolean', true, 0],
    ['бесконечность', Number.POSITIVE_INFINITY, 0]
  ])('%s → %s', (_name, input, expected) => {
    expect(toNumber(input)).toBe(expected)
  })
})
