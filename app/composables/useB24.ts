import { B24Frame, Result, initializeB24Frame } from '@bitrix24/b24jssdk'
import { B24_REQUIRED_SCOPES } from '~/config/b24'

/**
 * Единственный экземпляр `B24Frame` на страницу: портал открывает один iframe, а второй SDK завёл
 * бы вторые слушатели postMessage. Модульный синглтон безопасен при SSG — он ставится только на
 * клиенте и только внутри фрейма.
 */
let $b24: undefined | B24Frame = undefined
const type = ref<'undefined' | 'B24Frame'>('undefined')
/** Идущее рукопожатие: параллельные `init()` ждут его, а не создают второй `B24Frame`. */
let inFlight: undefined | Promise<Result> = undefined

export const useB24 = () => {
  function get() {
    return $b24
  }

  /** Живой `B24Frame` или исключение — звать только после успешного `init()`. */
  function getOrThrow(): B24Frame {
    if (!$b24) throw new Error('B24Frame не инициализирован')
    return $b24
  }

  function set(value: B24Frame | undefined): Result {
    if (value instanceof B24Frame) {
      if (!$b24) {
        $b24 = value
        nextTick(() => {
          type.value = 'B24Frame'
        })
      }
    } else {
      $b24 = undefined
      nextTick(() => {
        type.value = 'undefined'
      })
    }
    return new Result()
  }

  /**
   * Инициализация. Вне фрейма — тихий no-op: портал ставит `window.name` вида
   * `domain|protocol|appSid`, и его отсутствие означает, что мы открыты обычной вкладкой.
   */
  async function init(): Promise<Result> {
    if ($b24) return new Result()
    if (inFlight) return inFlight
    if (typeof window === 'undefined' || !window.name) return new Result()
    inFlight = (async () => {
      try {
        return set(await initializeB24Frame({}))
      } catch {
        // Не во фрейме портала по-настоящему — молчим, остаёмся standalone.
      }
      return new Result()
    })()
    try {
      return await inFlight
    } finally {
      inFlight = undefined
    }
  }

  function isInit() {
    return type.value !== 'undefined'
  }

  function targetOrigin() {
    return get()?.getTargetOrigin() || '?'
  }

  /** Права, которые нужны приложению, — для диагностики на странице установки. */
  function getRequiredRights(): string[] {
    return [...B24_REQUIRED_SCOPES]
  }

  /** Подогнать высоту фрейма под содержимое. Вне фрейма — no-op. */
  async function fitWindow(): Promise<void> {
    try {
      await get()?.parent.fitWindow()
    } catch { /* не во фрейме — подгонять нечего */ }
  }

  /**
   * Открыть страницу портала в его слайдере: карточку лида или сделки из детализации.
   *
   * ⚠ Путь — внутри портала, по `getTargetOrigin()`: чужие адреса `openPath` не открывает, а
   * ссылка `<a href>` на CRM внутри фрейма ушла бы в сам фрейм и сломала бы отчёт. Вне фрейма —
   * no-op с `false`: у демо-строк карточек нет.
   */
  async function openPath(path: string): Promise<boolean> {
    const frame = get()
    if (!frame || !path) return false
    try {
      await frame.slider.openPath(new URL(path, frame.getTargetOrigin()))
      return true
    } catch {
      return false
    }
  }

  return { init, get, getOrThrow, set, isInit, targetOrigin, getRequiredRights, fitWindow, openPath }
}
