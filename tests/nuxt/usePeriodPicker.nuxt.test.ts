// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
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

/** Панель «как настоящая»: период снаружи, применение — присваиванием. */
function picker(start: ReportPeriod = MONTH, maxDays?: number) {
  const period = ref<ReportPeriod>(start)
  const applied: ReportPeriod[] = []
  const api = usePeriodPicker({
    period,
    today: TODAY,
    ...(maxDays === undefined ? {} : { maxDays }),
    apply: (bounds) => {
      applied.push(bounds)
      period.value = bounds
    }
  })
  return { ...api, period, applied }
}

describe('usePeriodPicker: готовые интервалы', () => {
  it('подсвечивает интервал, совпавший с текущим периодом', () => {
    const p = picker()
    expect(p.activePreset.value).toBe('this-month')
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
    expect(picker({ from: '2026-09-01', to: '2026-09-30' }).activePreset.value).toBe('this-month')
    expect(picker({ from: '2026-09-03', to: '2026-09-17' }).activePreset.value).toBe('custom')
  })

  // Самый длинный готовый интервал в общий предел укладывается — панель не должна отказывать
  // человеку в том, что сама же ему предлагает.
  it('«текущий год» проходит проверку и применяется', () => {
    const p = picker()
    p.pickPreset('this-year')
    expect(p.applied).toEqual([{ from: '2026-01-01', to: '2026-12-31' }])
    expect(p.problem.value).toBeUndefined()
  })

  /**
   * ⚠ Готовые интервалы проходят ту же проверку, что и ручные. Сегодня ни один в предел не
   * упирается, но без проверки новый интервал обходил бы его одним нажатием — и человек ждал бы
   * минуты, не понимая почему. Предел здесь задан явно, чтобы эта ветка вообще проверялась.
   */
  it('интервал длиннее предела не применяется, а объясняется', () => {
    const p = picker(MONTH, 10)
    p.pickPreset('prev-month')
    expect(p.applied).toEqual([])
    expect(p.problem.value).toContain('10 дней')
  })

  it('следующий выбор снимает прежнюю жалобу', () => {
    const p = picker(MONTH, 10)
    p.pickPreset('prev-month')
    expect(p.problem.value).toBeDefined()
    p.pickPreset('today')
    expect(p.problem.value).toBeUndefined()
    expect(p.applied).toEqual([{ from: '2026-09-15', to: '2026-09-15' }])
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

  // Нестандартный период, пришедший снаружи (например, восстановленный из настроек портала),
  // открывает поле сам: иначе календарь показывал бы даты, которые нельзя поправить.
  it('нестандартный период снаружи открывает поле', () => {
    expect(picker({ from: '2026-09-03', to: '2026-09-17' }).isCustomActive.value).toBe(true)
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

  // Период сменился снаружи (кнопка в другой части панели, восстановленный отбор) — поля идут за
  // ним, иначе календарь показывал бы прошлый выбор.
  it('период, пришедший снаружи, подтягивает поля', async () => {
    const p = picker()
    p.period.value = { from: '2026-07-01', to: '2026-07-31' }
    await nextTick()
    expect([p.customFrom.value, p.customTo.value]).toEqual(['2026-07-01', '2026-07-31'])
  })

  // Повторное применение тех же границ — лишний запрос к порталу на десяток секунд.
  it('те же границы второй раз не применяются', async () => {
    const p = picker()
    p.pickPreset('custom')
    p.customFrom.value = MONTH.from
    p.customTo.value = MONTH.to
    await nextTick()
    expect(p.applied).toEqual([])
  })
})
