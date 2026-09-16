import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Палитра экрана блокировки — сторож той же породы, что `tests/palette.test.ts`.
 *
 * ⛔ Заведён по молчаливому дефекту, пойманному на собранном CSS: `:global(.dark) .lock-scene`
 * компилятор scoped-стилей схлопнул в просто `.dark`. Переменные уехали на `<html>`, а
 * `.lock-scene` тут же перебил их своим СВЕТЛЫМ набором — в тёмной теме экскаватор оставался
 * светлым, и ни типы, ни сборка, ни тесты компонента этого не видели. Заметить можно было только
 * глазами и только в тёмной теме портала.
 */
const source = readFileSync(join(import.meta.dirname, '..', 'app', 'components', 'PaymentLockScreen.vue'), 'utf-8')

/**
 * Исходник без комментариев.
 *
 * ⚠ Нужен там, где проверка ищет ЗАПРЕЩЁННУЮ строку: комментарии этого файла объясняют, почему
 * `100vh` здесь нельзя, — то есть содержат ровно то, что проверка ловит. Без вычистки тест
 * краснел бы на собственном объяснении.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')

/** Правила стилей: селектор → тело. Разбор простой ровно настолько, насколько прост этот файл. */
const rules = new Map<string, string>(
  [...code.matchAll(/(^|\n)\s*([^{}@\n][^{}\n]*?)\s*\{([^{}]*)\}/g)].map(match => [match[2]!.trim(), match[3]!])
)

/** Имена переменных, объявленных правилом с этим селектором. */
function varsOf(selector: string): string[] {
  return [...(rules.get(selector) ?? '').matchAll(/--([a-z-]+)\s*:/g)].map(match => match[1]!).sort()
}

describe('экран блокировки: палитра', () => {
  /**
   * ⛔ Главная проверка. `:global()` в этом файле уже один раз съел селектор целиком, и починка
   * заметна только на собранном CSS. Обычный потомок (`.dark .lock-scene`) работает правильно:
   * атрибут области видимости Vue дописывает лишь к последнему звену.
   */
  it('тёмная тема цепляется обычным потомком, а не :global()', () => {
    expect(code).not.toContain(':global(')
    expect(rules.has('.dark .lock-scene')).toBe(true)
  })

  /**
   * ⚠ Наборы обязаны совпадать ИМЕНАМИ. Добавленная светлая переменная без тёмной пары не ломает
   * ничего видимого: в тёмной теме просто остаётся светлый цвет — то есть ровно тот дефект, из-за
   * которого этот файл и появился.
   */
  it('каждой светлой переменной сцены есть тёмная пара', () => {
    const light = varsOf('.lock-scene')
    expect(light.length).toBeGreaterThan(5)
    expect(varsOf('.dark .lock-scene')).toEqual(light)
  })

  /** То же для переменных вне рисунка: полоса отсчёта живёт на корне компонента. */
  it('переменные корня компонента тоже парные', () => {
    const light = varsOf('[data-testid=\'payment-lock\']')
    expect(light.length).toBeGreaterThan(0)
    expect(varsOf('.dark [data-testid=\'payment-lock\']')).toEqual(light)
  })

  /**
   * ⚠ Движение обязано отключаться. Человеку с вестибулярными нарушениями дёргающаяся картинка —
   * не оживление экрана, а недомогание, и видит он её не по своей воле.
   */
  it('анимация уважает prefers-reduced-motion', () => {
    expect(code).toContain('@media (prefers-reduced-motion: reduce)')
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? ''
    for (const animated of ['.lock-arm', '.lock-body', '.lock-puff', '.lock-beacon']) {
      expect(block).toContain(animated)
    }
  })

  /**
   * ⛔ Высота — в пикселях, а не в `vh`. `100vh` внутри фрейма равен высоте фрейма, а `fitWindow`
   * эту высоту как раз и сжимает: вместе они дают самоподдерживающееся схлопывание, из-за которого
   * настоящий слайдер портала выглядел чужим окошком в треть экрана.
   */
  it('высота не задаётся в vh', () => {
    expect(code).not.toMatch(/\b(min-h-screen|h-screen|\d+vh)\b/)
    expect(code).toMatch(/min-h-\[\d+px\]/)
  })
})
