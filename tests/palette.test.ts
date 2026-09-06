import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHART_SLOTS } from '~/utils/managerChart'

/**
 * Палитра диаграмм: проверка того, что до сих пор было только обещанием в комментарии.
 *
 * ⚠ Этот тест появился потому, что комментарий врал. В нём стояла «худшая соседняя пара ΔE 33.5»,
 * а порядок слотов, лежавший в коде, давал 7.1 при пороге 8 — то есть НЕ проходил. Проверить это
 * было нечем: числа считались один раз черновым скриптом и в репозиторий не попали. Теперь считает
 * тест, и порядок слотов нельзя поменять «на глаз», не увидев красного.
 *
 * Проверяется ровно то, на чём построено решение (`app/assets/css/main.css`):
 * 1) СОСЕДНИЕ по кругу сектора различимы, в том числе при трёх видах дальтонизма, — потому что
 *    двенадцати попарно различимых цветов не существует, а глазом сравнивают соседей;
 * 2) подпись на сплошном секторе читается (`--chart-N-ink`);
 * 3) подпись на ПОЛУПРОЗРАЧНОМ внешнем кольце читается (`--chart-ink-veiled`) — там сектор
 *    подмешивает фон карточки, и обычные чернила падают до 2,7:1.
 */

type RGB = readonly [number, number, number]

const CSS = readFileSync(fileURLToPath(new URL('../app/assets/css/main.css', import.meta.url)), 'utf8')

/** Порог различимости соседей в CIE Lab. Ниже него соседние сектора сливаются. */
const DELTA_E_MIN = 8

/** Порог контраста подписи. 4.5:1 — требование WCAG к обычному тексту; 4.3 — допуск на округление. */
const CONTRAST_MIN = 4.3

/** Прозрачность внешнего кольца — та же, что рисует `SunburstChart.vue` (`ringOpacity(1)`). */
const VEIL = 0.7

/** Переменные одной темы: `:root` — светлая, `.dark` — тёмная. */
function theme(selector: string): Record<string, RGB> {
  const start = CSS.indexOf(`${selector} {`, CSS.indexOf('--chart-1:') - 2000)
  const block = CSS.slice(start, CSS.indexOf('\n  }', start))
  const out: Record<string, RGB> = {}
  for (const match of block.matchAll(/(--chart-[\w-]+):\s*#([0-9a-f]{6})/g)) {
    const hex = match[2]!
    out[match[1]!] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as unknown as RGB
  }
  return out
}

const channel = (value: number): number => {
  const s = value / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const luminance = (c: RGB): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])

function contrast(a: RGB, b: RGB): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** Как сектор выглядит поверх фона карточки при заданной прозрачности. */
const veil = (color: RGB, surface: RGB, alpha: number): RGB =>
  color.map((v, i) => Math.round(v * alpha + surface[i]! * (1 - alpha))) as unknown as RGB

function lab(c: RGB): [number, number, number] {
  const [r, g, b] = c.map(channel) as unknown as RGB
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

const deltaE = (a: RGB, b: RGB): number => {
  const [p, q] = [lab(a), lab(b)]
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

/**
 * Как эти цвета видит человек с дальтонизмом: протанопия, дейтеранопия, тританопия.
 *
 * Матрицы работают в ЛИНЕЙНОМ sRGB (Viénot–Brettel–Mollon), поэтому цвет сначала распрямляется
 * `channel()`, а после — гаммируется обратно.
 */
const VISION: Record<string, number[][] | undefined> = {
  'обычное зрение': undefined,
  'протанопия': [[0.152, 1.053, -0.205], [0.115, 0.786, 0.099], [-0.004, -0.048, 1.052]],
  'дейтеранопия': [[0.367, 0.861, -0.228], [0.280, 0.673, 0.047], [-0.012, 0.043, 0.969]],
  'тританопия': [[1.256, -0.077, -0.179], [-0.078, 0.931, 0.148], [0.005, 0.691, 0.304]]
}

function seen(color: RGB, matrix: number[][] | undefined): RGB {
  if (!matrix) return color
  const linear = color.map(channel) as unknown as RGB
  const gamma = (v: number): number => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
  return matrix.map(row => Math.min(255, Math.max(0, gamma(Math.min(1, Math.max(0, row[0]! * linear[0] + row[1]! * linear[1] + row[2]! * linear[2])))))) as unknown as RGB
}

const THEMES = [[':root', 'светлая'], ['.dark', 'тёмная']] as const

describe.each(THEMES)('палитра, %s тема', (selector, name) => {
  const vars = theme(selector)
  const color = (key: string): RGB => {
    const value = vars[key]
    // Пропущенная переменная — это не «ноль контраста», а сломанный разбор CSS: тест обязан
    // упасть с понятной причиной, а не тихо сравнить чёрное с чёрным.
    expect(value, `${key} в теме «${name}» не найден`).toBeDefined()
    return value!
  }

  it('соседние по кругу сектора различимы при любом зрении', () => {
    for (const [vision, matrix] of Object.entries(VISION)) {
      for (const [index, slot] of CHART_SLOTS.entries()) {
        const next = CHART_SLOTS[(index + 1) % CHART_SLOTS.length]!
        const distance = deltaE(seen(color(`--chart-${slot}`), matrix), seen(color(`--chart-${next}`), matrix))
        expect(distance, `слоты ${slot} и ${next}, ${vision}`).toBeGreaterThanOrEqual(DELTA_E_MIN)
      }
    }
  })

  it('подпись читается на сплошном секторе', () => {
    for (let slot = 1; slot <= CHART_SLOTS.length; slot++) {
      expect(contrast(color(`--chart-${slot}-ink`), color(`--chart-${slot}`)), `слот ${slot}`)
        .toBeGreaterThanOrEqual(CONTRAST_MIN)
    }
  })

  /**
   * ⚠ Внешнее кольцо рисуется полупрозрачным, и на нём `--chart-N-ink` НЕ работает: сектор
   * подмешивает фон карточки, контраст падает до 2,7:1. Спасает то, что смешение всегда идёт в
   * сторону фона, — значит, годится один цвет на тему.
   */
  it('подпись читается на полупрозрачном внешнем кольце', () => {
    const surface = color('--chart-surface')
    for (let slot = 1; slot <= CHART_SLOTS.length; slot++) {
      expect(contrast(color('--chart-ink-veiled'), veil(color(`--chart-${slot}`), surface, VEIL)), `слот ${slot}`)
        .toBeGreaterThanOrEqual(CONTRAST_MIN)
    }
  })

  /**
   * Сектора «Остальные» и «Без ответственного» палитрой не красятся — иначе тринадцатый сектор
   * получил бы цвет первого и встал с ним рядом, потому что круг замыкается.
   */
  it('служебные сектора отличимы и от палитры, и друг от друга', () => {
    const muted = color('--chart-muted')
    const strong = color('--chart-muted-strong')
    expect(deltaE(muted, strong)).toBeGreaterThanOrEqual(DELTA_E_MIN)
    for (const slot of CHART_SLOTS) {
      expect(deltaE(muted, color(`--chart-${slot}`)), `«Без ответственного» и слот ${slot}`).toBeGreaterThanOrEqual(DELTA_E_MIN)
      expect(deltaE(strong, color(`--chart-${slot}`)), `«Остальные» и слот ${slot}`).toBeGreaterThanOrEqual(DELTA_E_MIN)
    }
    for (const key of ['--chart-muted', '--chart-muted-strong']) {
      expect(contrast(color('--chart-muted-ink'), color(key)), key).toBeGreaterThanOrEqual(CONTRAST_MIN)
    }
  })
})

describe('порядок слотов', () => {
  it('содержит каждый цвет палитры ровно один раз', () => {
    expect([...CHART_SLOTS].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })
})
