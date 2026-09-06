// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { usePortalSlider } from '~/composables/usePortalSlider'
import {
  DRILL_OPTION_KEY,
  DRILL_PAYLOAD_KEY,
  DRILL_SLIDER_PLACE,
  DRILL_SLIDER_WIDTH,
  encodeDrillHandoff,
  type DrillSliderPayload
} from '~/utils/drillSlider'

/**
 * Настоящий слайдер портала: единственное место, где отчёт зовёт `openSliderAppPage`.
 *
 * ⚠ Условие едет НЕ параметрами вызова. Этот канал (`PLACEMENT_OPTIONS`) килобайтов не держит:
 * на боевом портале короткий `place` доехал, а JSON фильтра — нет, и человек увидел «Список не
 * открылся» при исправном отчёте. Теперь через параметры едет только короткий одноразовый ключ, а
 * условие — через `user.option` портала. Здесь проверяется ровно эта развязка.
 */

const sdk = vi.hoisted(() => ({
  /** `undefined` — мы вне портала: фрейма нет. */
  frame: undefined as unknown,
  /** SDK падает СИНХРОННО — так он ведёт себя на неподдерживаемых устройствах. */
  throws: false,
  calls: [] as Array<Record<string, unknown>>,
  options: undefined as unknown,
  /** Что лежит в `user.option` портала. */
  stored: undefined as unknown,
  /** Портал не принял запись условия. */
  writeFails: false,
  writes: 0
}))

mockNuxtImport('useB24', () => () => ({
  isInit: () => Boolean(sdk.frame),
  get: () => {
    if (sdk.throws) throw new Error('SDK не поднялся')
    return sdk.frame
  }
}))

mockNuxtImport('useUserOptions', () => () => ({
  read: async () => undefined,
  readFresh: async (key: string) => (key === DRILL_OPTION_KEY ? sdk.stored : undefined),
  write: () => {},
  writeNow: async (key: string, value: string) => {
    sdk.writes++
    if (sdk.writeFails) return false
    if (key === DRILL_OPTION_KEY) sdk.stored = value
    return true
  }
}))

/** Фрейм портала, у которого `openSliderAppPage` возвращает заданный промис. */
function frame(promise: Promise<unknown>) {
  return {
    slider: {
      openSliderAppPage: (params: Record<string, unknown>) => {
        sdk.calls.push(params)
        return promise
      }
    },
    placement: { options: sdk.options }
  }
}

/** Фрейм с уже открытым слайдером: параметры вызова приезжают сюда. */
function openedWith(options: unknown) {
  sdk.options = options
  sdk.frame = frame(new Promise(() => {}))
}

const PAYLOAD: DrillSliderPayload = {
  entity: 'deal',
  title: 'Сделки: Минск · Иванов',
  filter: { CATEGORY_ID: 1, STAGE_ID: 'C1:NEW' },
  total: 27
}

beforeEach(() => {
  sdk.frame = undefined
  sdk.throws = false
  sdk.calls = []
  sdk.options = undefined
  sdk.stored = undefined
  sdk.writeFails = false
  sdk.writes = 0
})

describe('usePortalSlider', () => {
  /**
   * ⚠ В параметрах вызова — ТОЛЬКО короткий ключ, без условия. Это и есть суть развязки: канал
   * `PLACEMENT_OPTIONS` на боевом портале не донёс килобайтный JSON, а короткий скаляр донёс.
   */
  it('в слайдер уезжает короткий ключ, условие — в user.option', async () => {
    sdk.frame = frame(new Promise(() => {}))
    expect(await usePortalSlider().openDrill(PAYLOAD)).toBe(true)
    const params = sdk.calls[0]!
    expect(params.place).toBe(DRILL_SLIDER_PLACE)
    const nonce = String(params[DRILL_PAYLOAD_KEY])
    expect(nonce.length).toBeGreaterThan(8)
    // Условия в параметрах нет ни под каким видом.
    expect(JSON.stringify(params)).not.toContain('C1:NEW')
    // ⚠ Именно `bx24_`: без префикса портал считает это данными приложения и молча игнорирует.
    expect(params.bx24_width).toBe(DRILL_SLIDER_WIDTH)
    expect(params.bx24_title).toBe(PAYLOAD.title)
    // А условие лежит в портале под тем же ключом.
    expect(JSON.parse(String(sdk.stored))).toEqual({ nonce, payload: PAYLOAD })
  })

  /**
   * ⚠ Запись ДОЖИДАЕМСЯ. Открой мы слайдер раньше, чем портал принял её, свежий фрейм прочитал бы
   * условие ПРОШЛОГО нажатия и показал бы чужой список под верным заголовком.
   */
  it('слайдер не открывается, пока условие не записано', async () => {
    sdk.frame = frame(new Promise(() => {}))
    sdk.writeFails = true
    expect(await usePortalSlider().openDrill(PAYLOAD)).toBe(false)
    expect(sdk.writes).toBe(1)
    expect(sdk.calls).toHaveLength(0)
  })

  it.each([
    ['вне портала фрейма нет', () => { sdk.frame = undefined }],
    ['SDK падает синхронно', () => { sdk.throws = true }]
  ])('%s — запасной путь, а не поломка клика', async (_name, prepare) => {
    prepare()
    expect(await usePortalSlider().openDrill(PAYLOAD)).toBe(false)
    expect(sdk.calls).toHaveLength(0)
    // Условие в портал не пишем, раз открывать нечем.
    expect(sdk.writes).toBe(0)
  })

  it('открытый фрейм читает своё условие обратно', async () => {
    const nonce = 'ключ-1'
    sdk.stored = encodeDrillHandoff(nonce, PAYLOAD)
    openedWith({ place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: nonce })
    const read = await usePortalSlider().readDrill()
    expect(read.ok && read.payload).toEqual(PAYLOAD)
    expect(usePortalSlider().drillRequested()).toBe(true)
  })

  /**
   * ⚠ `PLACEMENT_OPTIONS` приходит объектом ЛИБО JSON-строкой: SDK кладёт их как есть
   * (`placement.mjs`), а регистр ключей задаёт портал — остальные поля он шлёт заглавными
   * (`PLACEMENT`, `LANG`, `IS_ADMIN`). Наивное чтение молча даёт «фрейм не детализация».
   */
  it.each([
    ['объектом', (n: string) => ({ place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: n })],
    ['JSON-строкой', (n: string) => JSON.stringify({ place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: n })],
    ['заглавными ключами', (n: string) => ({ PLACE: DRILL_SLIDER_PLACE, DRILL: n })]
  ])('ключ условия читается, когда параметры пришли %s', async (_name, build) => {
    const nonce = 'ключ-2'
    sdk.stored = encodeDrillHandoff(nonce, PAYLOAD)
    openedWith(build(nonce))
    const read = await usePortalSlider().readDrill()
    expect(read.ok && read.payload).toEqual(PAYLOAD)
  })

  /**
   * ⚠ Метка одноразовая: нажали два числа подряд — второе перезаписало условие. Слайдер первого
   * обязан СКАЗАТЬ об этом, а не показать список второго под своим заголовком.
   */
  it('условие другого нажатия отвергается с внятной причиной', async () => {
    sdk.stored = encodeDrillHandoff('ключ-новый', PAYLOAD)
    openedWith({ place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: 'ключ-старый' })
    const read = await usePortalSlider().readDrill()
    expect(read.ok).toBe(false)
    expect(read.ok ? '' : read.reason).toMatch(/устарело/)
  })

  /**
   * ⚠ Отказ обязан называть ПРИЧИНУ. Отказов у разбора десяток, по экрану они неразличимы, а
   * чинятся по-разному — «в портале нет записи» и «поле условия не разрешено» требуют разного.
   */
  it.each([
    ['записи в портале нет', undefined, /условия в user.option нет/],
    ['запись не разбирается', '{обрезано', /не разбирается/],
    ['поле не из белого списка', encodeDrillHandoff('ключ-3', { ...PAYLOAD, filter: { UF_SECRET: 'x' } }), /поле условия не разрешено: UF_SECRET/]
  ])('причина отказа названа: %s', async (_name, stored, expected) => {
    sdk.stored = stored
    openedWith({ place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: 'ключ-3' })
    const read = await usePortalSlider().readDrill()
    expect(read.ok).toBe(false)
    expect(read.ok ? '' : read.reason).toMatch(expected)
  })

  // ⚠ В причине НЕТ данных CRM: экран слайдера смотрит не только тот, кто нажал на число.
  it('причина не выносит наружу значений условия и заголовка', async () => {
    sdk.stored = encodeDrillHandoff('ключ-4', { ...PAYLOAD, title: 'Сделки Иванова', filter: { UF_SECRET: 'секрет-клиента' } })
    openedWith({ place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: 'ключ-4' })
    const read = await usePortalSlider().readDrill()
    const reason = read.ok ? '' : read.reason
    expect(reason).not.toContain('секрет-клиента')
    expect(reason).not.toContain('Иванова')
  })

  it('чужие параметры вызова — не детализация', async () => {
    openedWith({ place: 'CRM_ANALYTICS_MENU' })
    expect(usePortalSlider().drillRequested()).toBe(false)
    const read = await usePortalSlider().readDrill()
    expect(read.ok).toBe(false)
  })

  // Страница зовёт это ДО отрисовки: исключение оставило бы человека с пустым экраном.
  it('сбой SDK при чтении параметров не роняет страницу', async () => {
    sdk.throws = true
    expect(usePortalSlider().drillRequested()).toBe(false)
    const read = await usePortalSlider().readDrill()
    expect(read.ok).toBe(false)
  })
})
