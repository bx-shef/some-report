import type { MaybeRefOrGetter } from 'vue'
import type { ReportPeriod } from '~/types/report'
import { PERIOD_PRESETS, matchPreset, resolvePreset, samePeriod, validatePeriod, type PeriodPresetId } from '~/utils/period'

/**
 * Выбор периода: готовые интервалы, режим «Произвольный» и проверка до запроса.
 *
 * Одна механика на ОБЕ панели. У отчёта по лидам период — самостоятельная модель, у отчёта по
 * менеджерам — часть отбора (`ManagerFilters.period`), но ведут себя они одинаково, и копия этой
 * логики в двух компонентах уже расходилась бы при первой же правке: панели давали бы отчётам
 * разные границы под одинаковыми кнопками — расхождение, которое видно только при сверке двух
 * отчётов между собой, то есть не видно никогда.
 *
 * ⚠ Своего состояния «текущий период» здесь НЕТ. Источник истины остаётся снаружи (проп панели),
 * а композабл только читает его и зовёт `apply`. Иначе появилось бы второе место, где живёт
 * период, и рассинхрон был бы вопросом времени.
 *
 * Разметку к этой механике держит `PeriodPicker.vue` — он же и единственный, кто зовёт композабл.
 */
export function usePeriodPicker(options: {
  /** Выбранный период — источник истины снаружи. */
  period: MaybeRefOrGetter<ReportPeriod>
  /** «Сегодня»: интервалы считаются от него, и в тестах он должен быть задан. */
  today: MaybeRefOrGetter<Date>
  /** Как применить новый период. Панель решает сама: эмитом или присвоением в свою модель. */
  apply: (period: ReportPeriod) => void
  /**
   * Идёт выборка — период не меняют.
   *
   * ⚠ Проверка живёт ЗДЕСЬ, а не только в разметке кнопок. Календарь произвольных дат отключить
   * атрибутом нельзя (у поля b24ui нет такого свойства), и без этой проверки человек менял бы
   * период посреди шестнадцатисекундной выборки — портал получал бы вторую такую же следом.
   */
  disabled?: MaybeRefOrGetter<boolean>
}) {
  const period = computed(() => toValue(options.period))
  const today = computed(() => toValue(options.today))
  const disabled = computed(() => Boolean(toValue(options.disabled)))

  /** Какой готовый интервал сейчас выбран. Ручной ввод «01.09 — 30.09» подсветит «Текущий месяц». */
  const activePreset = computed(() => matchPreset(period.value, today.value))

  /** Человек нажал «Произвольный» — поле открыто, даже если даты совпадают с готовым интервалом. */
  const customOpen = ref(false)

  /**
   * Произвольный режим активен ОДНИМ условием — для подсветки, поля и применения правок.
   *
   * ⚠ Раньше условий было два: поле показывалось при «период не совпал ни с одним интервалом», а
   * правки применялись только при «нажали Произвольный». Пришедший снаружи нестандартный период
   * открывал календарь, в котором можно было выбирать сколько угодно — и ничего не происходило.
   */
  const isCustomActive = computed(() => customOpen.value || activePreset.value === 'custom')

  const customFrom = ref(period.value.from)
  const customTo = ref(period.value.to)

  function syncCustomToApplied(): void {
    customFrom.value = period.value.from
    customTo.value = period.value.to
  }

  watch(period, syncCustomToApplied)

  // Поле закрыли — недобранная половина выбора не должна ждать следующего открытия.
  watch(isCustomActive, (active) => {
    if (!active) syncCustomToApplied()
  })

  /** Активна ли кнопка интервала. Одна функция для цвета и `aria-pressed`: разойтись им негде. */
  function isPresetActive(id: PeriodPresetId): boolean {
    return id === 'custom' ? isCustomActive.value : id === activePreset.value && !customOpen.value
  }

  /** Проблема периода, о которой нужно сказать до запроса. */
  const problem = ref<string | undefined>(undefined)

  function pickPreset(id: PeriodPresetId): void {
    if (disabled.value) return
    problem.value = undefined
    if (id === 'custom') {
      // ⚠ Именно ПЕРЕКЛЮЧАТЕЛЬ. Кнопка помечена `aria-pressed`, то есть обещает нажатое и
      // отжатое состояние; при `customOpen = true` повторное нажатие ничего не делало, и закрыть
      // календарь можно было только выбрав другой интервал — со скринридера это выглядит как
      // сломанный переключатель.
      customOpen.value = !customOpen.value
      return
    }
    customOpen.value = false
    const bounds = resolvePreset(id, today.value)
    if (!bounds) return
    // ⚠ Тот же период второй раз в портал НЕ уходит. Нажатие на уже подсвеченную кнопку — обычное
    // дело (и двойной клик тоже), а стоит оно полной выборки отчёта: шестнадцать секунд запросов
    // и лишняя запись отбора в настройки портала.
    if (samePeriod(bounds, period.value)) return
    // ⚠ Готовые интервалы проходят ту же проверку, что и ручные. Сегодня ни один в предел не
    // упирается («текущий год» — 365–366 дней при пределе 366), но интервал длиннее добавят
    // однажды, и он обошёл бы предел одним нажатием — а человек ждал бы минуты, не понимая, чем
    // он это заслужил.
    const issue = validatePeriod(bounds)
    if (issue) {
      problem.value = issue.message
      return
    }
    options.apply(bounds)
  }

  /**
   * Проблема выбранного вручную периода.
   *
   * ⚠ Проверяем ДО запроса. Перевёрнутый период REST принимает без ошибки и возвращает пустой
   * список — отчёт показал бы нули, неотличимые от «за период ничего не было», и человек искал бы
   * ошибку в CRM, а она у него на экране.
   */
  const customProblem = computed(() => {
    if (!customFrom.value || !customTo.value) return undefined
    return validatePeriod({ from: customFrom.value, to: customTo.value })
  })

  // Обе границы выбраны и период годный — применяем. Одна граница — человек ещё выбирает.
  watch([customFrom, customTo], () => {
    if (disabled.value || !isCustomActive.value) return
    if (!customFrom.value || !customTo.value || customProblem.value) return
    const picked = { from: customFrom.value, to: customTo.value }
    if (samePeriod(picked, period.value)) return
    // ⚠ Закрепляем режим за человеком. Поле могло открыться САМО — от нестандартного периода,
    // восстановленного из настроек портала, — и как только выбранный диапазон совпал бы с готовым
    // интервалом, оно схлопнулось бы прямо под рукой, посреди выбора.
    customOpen.value = true
    options.apply(picked)
  })

  return {
    /** Список интервалов — разметка рисует по нему кнопки, порядок задан в `period.ts`. */
    presets: PERIOD_PRESETS,
    isCustomActive,
    isPresetActive,
    customFrom,
    customTo,
    problem,
    customProblem,
    pickPreset
  }
}
