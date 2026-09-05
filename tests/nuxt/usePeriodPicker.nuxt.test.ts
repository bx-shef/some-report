// @vitest-environment nuxt
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { usePeriodPicker } from '~/composables/usePeriodPicker'
import type { ReportPeriod } from '~/types/report'

/**
 * Общий выбор периода обеих панелей.
 *
 * ⚠ Проверяем то, что ломается молча и одинаково в обоих отчётах: применяется ли выбранный
 * интервал, не уходит ли в портал негодный период и не «залипает» ли режим произвольных дат.
 * Раньше эта логика жила двумя копиями, и разъехавшись, они дали бы отчётам разные границы под
 * одинаковыми кнопками.
 */
const TODAY = new Date(2026, 8, 15)
const MONTH: ReportPeriod = { from: '2026-09-01', to: '2026-09-30' }

/**
 * Панель «как настоящая»: период снаружи, применение — присваиванием.
 *
 * ⚠ Наблюдатели заводятся внутри `effectScope`, как в компоненте: без него они пережили бы тест и
 * продолжали срабатывать в следующем — то есть проверялась бы не та форма, в которой композабл
 * живёт в панели.
 */
const scopes: EffectScope[] = []

afterEach(() => {
  while (scopes.length) scopes.pop()!.stop()
})

function picker(start: ReportPeriod = MONTH, disabled = ref(false)) {
  const period = ref<ReportPeriod>(start)
  const applied: ReportPeriod[] = []
  const scope = effectScope()
  scopes.push(scope)
  const api = scope.run(() => usePeriodPicker({
    period,
    today: TODAY,
    disabled,
    apply: (bounds) => {
      applied.push(bounds)
      period.value = bounds
    }
  }))!
  return { ...api, period, applied, disabled }
}

describe('usePeriodPicker: готовые интервалы', () => {
  it('подсвечивает интервал, совпавший с текущим периодом', () => {
    const p = picker()
    expect(p.isPresetActive('this-month')).toBe(true)
    expect(p.isPresetActive('prev-month')).toBe(false)
  })

  it('нажатие интервала применяет его границы', () => {
    const p = picker()
    p.pickPreset('prev-month')
    expect(p.applied).toEqual([{ from: '2026-08-01', to: '2026-08-31' }])
  })

  // Ручной ввод «01.09 — 30.09» обязан подсветить «Текущий месяц»: иначе человек видит, что
  // система не понимает того, что он только что выбрал.
  it('произвольные даты, совпавшие с интервалом, подсвечивают его', () => {
    expect(picker({ from: '2026-09-01', to: '2026-09-30' }).isPresetActive('this-month')).toBe(true)
    expect(picker({ from: '2026-09-03', to: '2026-09-17' }).isPresetActive('custom')).toBe(true)
  })

  // Самый длинный готовый интервал в общий предел (366 дней) укладывается — панель не должна
  // отказывать человеку в том, что сама же ему предлагает.
  it('«текущий год» проходит проверку и применяется', () => {
    const p = picker()
    p.pickPreset('this-year')
    expect(p.applied).toEqual([{ from: '2026-01-01', to: '2026-12-31' }])
    expect(p.problem.value).toBeUndefined()
  })

  /**
   * ⚠ Нажатие на уже подсвеченную кнопку (и двойной клик) в портал НЕ уходит.
   *
   * Стоит такое нажатие полной выборки отчёта — на боевом портале это шестнадцать секунд запросов
   * и лишняя запись отбора в настройки. Проверка «тот же период» была у ручного ввода и не была у
   * кнопок; найдено ревью.
   */
  it('повторное нажатие того же интервала ничего не применяет', () => {
    const p = picker()
    p.pickPreset('this-month')
    p.pickPreset('this-month')
    expect(p.applied).toEqual([])
  })

  it('нажатие соседнего интервала после того же — применяется', () => {
    const p = picker()
    p.pickPreset('this-month')
    p.pickPreset('prev-month')
    expect(p.applied).toEqual([{ from: '2026-08-01', to: '2026-08-31' }])
  })
})

describe('usePeriodPicker: во время выборки', () => {
  // Каждая смена периода — секунды запросов к порталу; пока идёт выборка, менять его нельзя.
  it('кнопки интервалов ничего не применяют', () => {
    const p = picker(MONTH, ref(true))
    p.pickPreset('prev-month')
    expect(p.applied).toEqual([])
  })

  /**
   * ⚠ И календарь тоже. Атрибутом его не закрыть — у поля дат b24ui нет `disabled`, — поэтому
   * запрет живёт в самой логике: иначе человек менял бы период посреди выборки, и портал получал
   * бы вторую такую же следом.
   */
  it('произвольные даты во время выборки не применяются', async () => {
    const p = picker(MONTH, ref(true))
    p.customFrom.value = '2026-09-05'
    p.customTo.value = '2026-09-10'
    await nextTick()
    expect(p.applied).toEqual([])
  })
})

describe('usePeriodPicker: произвольный период', () => {
  it('«Произвольный» открывает поле и подсвечивается сам', () => {
    const p = picker()
    p.pickPreset('custom')
    expect(p.isCustomActive.value).toBe(true)
    expect(p.isPresetActive('custom')).toBe(true)
    // ⚠ Пока открыт произвольный режим, кнопка совпавшего интервала НЕ активна: иначе на панели
    // горели бы две кнопки сразу.
    expect(p.isPresetActive('this-month')).toBe(false)
  })

  /**
   * ⚠ Кнопка помечена `aria-pressed`, то есть обещает нажатое и отжатое состояние. Раньше
   * повторное нажатие ничего не делало, и закрыть календарь можно было только выбрав другой
   * интервал — со скринридера это выглядит как сломанный переключатель.
   */
  it('повторное нажатие «Произвольного» закрывает поле', () => {
    const p = picker()
    p.pickPreset('custom')
    p.pickPreset('custom')
    expect(p.isCustomActive.value).toBe(false)
    expect(p.applied).toEqual([])
  })

  // Нестандартный период, пришедший снаружи (например, восстановленный из настроек портала),
  // открывает поле сам: иначе календарь показывал бы даты, которые нельзя поправить.
  it('нестандартный период снаружи открывает поле', () => {
    expect(picker({ from: '2026-09-03', to: '2026-09-17' }).isCustomActive.value).toBe(true)
  })

  /**
   * ⚠ Поле, открывшееся САМО, не должно схлопнуться под рукой. Человек правит нестандартный
   * период, выбранный диапазон случайно совпадает с готовым интервалом — и календарь исчезал бы
   * посреди выбора, а вернуть его можно было только нажав «Произвольный».
   */
  it('поле остаётся открытым, когда выбранное совпало с готовым интервалом', async () => {
    const p = picker({ from: '2026-09-03', to: '2026-09-17' })
    p.customFrom.value = '2026-09-01'
    p.customTo.value = '2026-09-30'
    await nextTick()
    expect(p.applied).toEqual([{ from: '2026-09-01', to: '2026-09-30' }])
    expect(p.isCustomActive.value).toBe(true)
  })

  it('обе границы выбраны — период применяется', async () => {
    const p = picker()
    p.pickPreset('custom')
    p.customFrom.value = '2026-09-05'
    p.customTo.value = '2026-09-10'
    await nextTick()
    expect(p.applied).toEqual([{ from: '2026-09-05', to: '2026-09-10' }])
  })

  it('одна граница — ещё не выбор, в портал ничего не уходит', async () => {
    const p = picker()
    p.pickPreset('custom')
    p.customFrom.value = '2026-09-05'
    p.customTo.value = ''
    await nextTick()
    expect(p.applied).toEqual([])
  })

  /**
   * ⚠ Перевёрнутый период REST принимает без ошибки и возвращает пустой список — отчёт показал бы
   * нули, неотличимые от «за период ничего не было», и человек искал бы ошибку в CRM, а она у
   * него на экране.
   */
  it('перевёрнутый период не уходит в запрос и объясняется', async () => {
    const p = picker()
    p.pickPreset('custom')
    p.customFrom.value = '2026-09-30'
    p.customTo.value = '2026-09-01'
    await nextTick()
    expect(p.applied).toEqual([])
    expect(p.customProblem.value?.message).toContain('поменяны местами')
  })

  it('закрытие произвольного режима возвращает поля к применённому периоду', async () => {
    const p = picker()
    p.pickPreset('custom')
    p.customFrom.value = '2026-09-05'
    await nextTick()
    p.pickPreset('prev-month')
    await nextTick()
    expect(p.isCustomActive.value).toBe(false)
    expect([p.customFrom.value, p.customTo.value]).toEqual(['2026-08-01', '2026-08-31'])
  })

  /**
   * Период сменился снаружи (кнопка панели, восстановленный отбор) — поля идут за ним, иначе
   * календарь показывал бы прошлый выбор.
   *
   * ⚠ И обратно в портал этот же период НЕ уходит: подтягивание полей меняет их, наблюдатель
   * срабатывает, и без проверки «тот же период» отчёт пересчитывался бы сам по себе.
   */
  it('период, пришедший снаружи, подтягивает поля и не уходит обратно', async () => {
    const p = picker()
    p.period.value = { from: '2026-07-01', to: '2026-07-31' }
    await nextTick()
    expect([p.customFrom.value, p.customTo.value]).toEqual(['2026-07-01', '2026-07-31'])
    expect(p.applied).toEqual([])
  })

  // Повторный выбор тех же границ руками — лишний запрос к порталу на десяток секунд.
  it('те же границы второй раз не применяются', async () => {
    const p = picker()
    p.pickPreset('custom')
    p.customFrom.value = '2026-09-05'
    p.customTo.value = '2026-09-10'
    await nextTick()
    expect(p.applied).toHaveLength(1)
    p.customFrom.value = '2026-09-05'
    p.customTo.value = '2026-09-10'
    await nextTick()
    expect(p.applied).toHaveLength(1)
  })
})
