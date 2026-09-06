// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { usePortalSlider } from '~/composables/usePortalSlider'
import { DRILL_PAYLOAD_KEY, DRILL_SLIDER_PLACE, DRILL_SLIDER_WIDTH, type DrillSliderPayload } from '~/utils/drillSlider'

/**
 * Настоящий слайдер портала: единственное место, где отчёт зовёт `openSliderAppPage`.
 *
 * ⚠ Проверяем здесь ровно то, что ломается молча и не видно ни в одном другом тесте: вызов НЕ
 * ждёт промиса (он разрешается при ЗАКРЫТИИ слайдера, а на мобильном не разрешается никогда),
 * настройки едут с префиксом `bx24_`, а любой сбой SDK уводит на запасной путь, а не роняет клик.
 */

const sdk = vi.hoisted(() => ({
  /** `undefined` — мы вне портала: фрейма нет. */
  frame: undefined as unknown,
  /** SDK падает СИНХРОННО — так он ведёт себя на неподдерживаемых устройствах. */
  throws: false,
  calls: [] as Array<Record<string, unknown>>,
  options: undefined as unknown
}))

mockNuxtImport('useB24', () => () => ({
  isInit: () => Boolean(sdk.frame),
  get: () => {
    if (sdk.throws) throw new Error('SDK не поднялся')
    return sdk.frame
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
})

describe('usePortalSlider', () => {
  it('внутри портала просит открыть слайдер: место, нагрузка и настройки с префиксом', () => {
    sdk.frame = frame(new Promise(() => {}))
    expect(usePortalSlider().openDrill(PAYLOAD)).toBe(true)
    const params = sdk.calls[0]!
    expect(params.place).toBe(DRILL_SLIDER_PLACE)
    expect(JSON.parse(String(params[DRILL_PAYLOAD_KEY]))).toEqual(PAYLOAD)
    // ⚠ Именно `bx24_`: без префикса портал считает это данными приложения и молча игнорирует —
    // слайдер открывается стандартной ширины с пустой шапкой.
    expect(params.bx24_width).toBe(DRILL_SLIDER_WIDTH)
    expect(params.bx24_title).toBe(PAYLOAD.title)
  })

  /**
   * ⚠ Главный инвариант этого композабла. Промис `openSliderAppPage` разрешается, когда слайдер
   * ЗАКРЫЛИ, а на неподдерживаемом устройстве родитель не отвечает вовсе — промис не разрешается
   * никогда. Дождись мы его, клик по числу не делал бы РОВНО НИЧЕГО, и запасная панель тоже не
   * поднялась бы. Здесь промис не разрешается специально, а ответ всё равно есть.
   */
  it('ответ приходит сразу, а не по разрешению промиса', () => {
    sdk.frame = frame(new Promise(() => {}))
    expect(usePortalSlider().openDrill(PAYLOAD)).toBe(true)
  })

  // Отказ портала не должен всплывать необработанным: слайдер уже попросили, показывать нечего.
  it('отказ портала не выбрасывает исключение', async () => {
    sdk.frame = frame(Promise.reject(new Error('слайдер закрыт')))
    expect(usePortalSlider().openDrill(PAYLOAD)).toBe(true)
    await Promise.resolve()
  })

  it.each([
    ['вне портала фрейма нет', () => { sdk.frame = undefined }],
    ['SDK падает синхронно', () => { sdk.throws = true }]
  ])('%s — запасной путь, а не поломка клика', (_name, prepare) => {
    prepare()
    expect(usePortalSlider().openDrill(PAYLOAD)).toBe(false)
    expect(sdk.calls).toHaveLength(0)
  })

  it('нагрузку своего фрейма читает обратно, чужие параметры — не детализация', () => {
    sdk.options = { place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: JSON.stringify(PAYLOAD) }
    sdk.frame = frame(Promise.resolve())
    expect(usePortalSlider().drillPayload()).toEqual(PAYLOAD)
    expect(usePortalSlider().drillRequested()).toBe(true)

    sdk.options = { place: 'CRM_ANALYTICS_MENU' }
    sdk.frame = frame(Promise.resolve())
    expect(usePortalSlider().drillPayload()).toBeUndefined()
    expect(usePortalSlider().drillRequested()).toBe(false)
  })

  /**
   * ⚠ «Нажал на число, а параметры испортились» и «открыл приложение плиткой» дают одинаковое
   * `undefined` — и требуют РАЗНОГО на экране. Без этого признака страница показала бы человеку,
   * ждущему список, оглавление приложения и не сказала бы ни слова.
   */
  it('испорченная нагрузка — всё ещё фрейм детализации, а не обычное открытие', () => {
    sdk.options = { place: DRILL_SLIDER_PLACE, [DRILL_PAYLOAD_KEY]: '{обрезано по дороге' }
    sdk.frame = frame(Promise.resolve())
    expect(usePortalSlider().drillPayload()).toBeUndefined()
    expect(usePortalSlider().drillRequested()).toBe(true)
  })

  // Страница зовёт это ДО отрисовки: исключение оставило бы человека с пустым экраном.
  it('сбой SDK при чтении нагрузки не роняет страницу', () => {
    sdk.throws = true
    expect(usePortalSlider().drillPayload()).toBeUndefined()
    expect(usePortalSlider().drillRequested()).toBe(false)
  })
})
