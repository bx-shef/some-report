import type { MaybeRefOrGetter } from 'vue'
import type { ReportPeriod } from '~/types/report'
import { PERIOD_PRESETS, matchPreset, resolvePreset, validatePeriod, type PeriodPresetId } from '~/utils/period'

/**
 * Выбор периода: готовые интервалы, режим «Произвольный» и проверка до запроса.
 *
 * Одна механика на ОБЕ панели. У отчёта по лидам период — самостоятельная модель, у отчёта по
 * менеджерам — часть отбора (`ManagerFilters.period`), но ведут себя они одинаково, и копия этой
 * логики в двух компонентах уже расходилась бы при первой же правке: панели давали бы отчётам
 * разные границы под одинаковыми кнопками — расхождение, которое видно только при сверке двух
 * отчётов между собой, то есть не видно никогда.
 *
 * ⚠ Своего состояния «текущий период» здесь НЕТ. Источник истины остаётся снаружи (проп или
 * модель панели), а композабл только читает его и зовёт `apply`. Иначе появилось бы второе место,
 * где живёт период, и рассинхрон был бы вопросом времени.
 */
export function usePeriodPicker(options: {
  /** Выбранный период — источник истины снаружи. */
  period: MaybeRefOrGetter<ReportPeriod>
  /** «Сегодня»: интервалы считаются от него, и в тестах он должен быть задан. */
  today: MaybeRefOrGetter<Date>
  /** Как применить новый период. Панель решает сама: эмитом или присвоением в свою модель. */
  apply: (period: ReportPeriod) => void
  /**
   * Предел длины периода в днях. Умолчание — общее для отчётов (366, см. `validatePeriod`).
   *
   * ⚠ Параметр, а не константа, ровно по одной причине: сегодня ни один готовый интервал в него
   * не упирается (самый длинный — «текущий год», 365–366 дней), и ветка «интервал слишком
   * длинный» иначе не проверялась бы вовсе. Появится интервал длиннее или другой предел у
   * второго отчёта — менять придётся одну строку в панели, а не логику здесь.
   */
  maxDays?: number
}) {
  const period = computed(() => toValue(options.period))
  const today = computed(() => toValue(options.today))

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
    problem.value = undefined
    if (id === 'custom') {
      customOpen.value = true
      return
    }
    customOpen.value = false
    const bounds = resolvePreset(id, today.value)
    if (!bounds) return
    // ⚠ Готовые интервалы проходят ту же проверку, что и ручные: «текущий год» — это до 366 дней
    // выборки, и без проверки он обходил бы предел одним нажатием.
    const issue = validatePeriod(bounds, options.maxDays)
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
    return validatePeriod({ from: customFrom.value, to: customTo.value }, options.maxDays)
  })

  // Обе границы выбраны и период годный — применяем. Одна граница — человек ещё выбирает.
  watch([customFrom, customTo], () => {
    if (!isCustomActive.value) return
    if (!customFrom.value || !customTo.value || customProblem.value) return
    if (customFrom.value === period.value.from && customTo.value === period.value.to) return
    options.apply({ from: customFrom.value, to: customTo.value })
  })

  return {
    /** Список интервалов — панели рисуют по нему кнопки, порядок задан в `period.ts`. */
    presets: PERIOD_PRESETS,
    activePreset,
    isCustomActive,
    isPresetActive,
    customFrom,
    customTo,
    problem,
    customProblem,
    pickPreset
  }
}
