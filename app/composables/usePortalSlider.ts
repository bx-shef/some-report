import { decodeDrillPayload, encodeDrillPayload, DRILL_SLIDER_WIDTH, type DrillSliderPayload } from '~/utils/drillSlider'

/**
 * Настоящий слайдер портала для СВОИХ страниц приложения.
 *
 * ⚠ Не `slider.openPath`: тот открывает ПОРТАЛЬНЫЙ путь, то есть `<портал>/app/drill` → 404. Свою
 * страницу открывает только `openSliderAppPage` — она поднимает новый фрейм приложения поверх
 * портала и передаёт ему параметры вызова. Приём взят из соседнего `client-bank-alfa-by`, где им
 * открываются настройки, и в этом же виде уже отработан на живом портале.
 *
 * ⚠ Плейсмент под это НЕ регистрируется: `place` едет параметром ВЫЗОВА, а не привязкой. Значит,
 * ни `placement.bind`, ни переустановка приложения на боевых порталах не нужны.
 *
 * ⚠ Вне фрейма (прямая ссылка, `?preview=1`) слайдера нет вовсе, и это не ошибка, а штатный режим
 * страницы. Открывающая сторона обязана иметь запасной путь — у нас это прежняя панель b24ui
 * внутри отчёта. Поэтому `openDrill` возвращает `false`, а не бросает.
 */
export function usePortalSlider() {
  const b24 = useB24()

  /** Внутри портала мы или нет — только там слайдер существует. */
  function inFrame(): boolean {
    return b24.isInit()
  }

  /**
   * Открыть детализацию настоящим слайдером портала.
   *
   * @returns удалось ли открыть. `false` — вызывающий показывает список сам.
   */
  async function openDrill(payload: DrillSliderPayload): Promise<boolean> {
    const frame = b24.get()
    if (!frame) return false
    try {
      await frame.slider.openSliderAppPage({
        ...encodeDrillPayload(payload),
        width: DRILL_SLIDER_WIDTH,
        // ⚠ Заголовок задаём ЗДЕСЬ, а не только на странице: пока новый фрейм поднимается,
        // человек уже видит шапку слайдера. Пустая шапка на секунду читается как «открылось не
        // то», и её успевают закрыть.
        title: payload.title
      })
      return true
    } catch {
      // SDK падает на неподдерживаемых устройствах (мобильное приложение) — там останется
      // запасной путь вызывающего.
      return false
    }
  }

  /**
   * Нагрузка, с которой открыли ЭТОТ фрейм, — или `undefined`, если он открыт не слайдером
   * детализации либо параметры негодные.
   */
  function drillPayload(): DrillSliderPayload | undefined {
    const frame = b24.get()
    if (!frame) return undefined
    try {
      return decodeDrillPayload(frame.placement.options)
    } catch {
      return undefined
    }
  }

  /** Закрыть себя — кнопка «Закрыть» на странице, открытой слайдером. */
  async function closeSelf(): Promise<void> {
    const frame = b24.get()
    if (!frame) return
    try {
      await frame.slider.closeSliderAppPage()
    } catch {
      // Закрыть не удалось — у слайдера портала есть своя крестик-кнопка, человек не заперт.
    }
  }

  return { inFrame, openDrill, drillPayload, closeSelf }
}
