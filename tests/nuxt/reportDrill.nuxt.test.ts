// @vitest-environment nuxt
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReportDrill from '~/components/ReportDrill.vue'
import type { DrillRow } from '~/utils/drilldown'
import type { DrillSliderPayload } from '~/utils/drillSlider'
import { formatMoney } from '~/utils/format'

/**
 * Список записей во весь настоящий слайдер портала.
 *
 * ⚠ Компонент рисующий, и проверяем здесь именно то, что он РЕШАЕТ сам: подпись «показано M из
 * N», какой из четырёх экранов показать (читаем / пусто / таблица) и когда просить следующую
 * страницу. Подпись — единственная формула в компоненте, и по правилу проекта она обязана быть
 * под тестом: разойдясь с числом над списком, она врёт молча.
 */
const rows: DrillRow[] = [
  { id: 1, title: 'Сделка первая', when: '2026-08-10T10:00:00+03:00', stage: 'Новая', source: 'Звонок', manager: 'Иванова Анна', amount: 1500, currencyId: 'BYN', path: '/crm/deal/details/1/' },
  { id: 2, title: 'Сделка вторая', path: '/crm/deal/details/2/' }
]

const PAYLOAD: DrillSliderPayload = {
  entity: 'deal',
  title: 'Проигранные сделки: Отказ - Дорого',
  filter: { STAGE_ID: 'LOSE' },
  total: 60
}

let current: Awaited<ReturnType<typeof mountSuspended>> | undefined

async function render(props: Partial<{ payload: DrillSliderPayload, rows: DrillRow[], pending: boolean, done: boolean, error: string, openError: string }> = {}) {
  current = await mountSuspended(ReportDrill, {
    props: { payload: PAYLOAD, rows, pending: false, done: true, ...props },
    attachTo: document.body
  })
  await current.vm.$nextTick()
  return current
}

afterEach(() => {
  current?.unmount()
  current = undefined
  document.body.innerHTML = ''
})

const text = () => document.body.textContent ?? ''

describe('ReportDrill', () => {
  it('строки, суммы и заголовок — как в отчёте', async () => {
    await render()
    expect(text()).toContain('Проигранные сделки: Отказ - Дорого')
    expect(text()).toContain('Сделка первая')
    expect(text()).toContain('Иванова Анна')
    // ⚠ Сравниваем через ТУ ЖЕ функцию, что рисует экран: в `ru-RU` разряды делит неразрывный
    // пробел, и проверка с обычным пробелом краснела бы при совершенно верном числе.
    expect(text()).toContain(formatMoney(1500, 'BYN'))
    // Пустые поля второй строки — прочерк, а не пустое место.
    expect(text()).toContain('—')
  })

  /**
   * ⚠ Подпись обязана сходиться с числом, по которому нажали. «Показано M из N» до конца списка,
   * итог — после: перепутай их, и человек прочитает «сделок: 2» там, где их шестьдесят.
   */
  it.each([
    ['дочитано — итог', { done: true }, 'сделок: 2'],
    ['есть ещё, N известно', { done: false }, 'показано 2 из 60 сделок'],
    ['есть ещё, N неизвестно', { done: false, payload: { ...PAYLOAD, total: undefined } }, 'показано сделок: 2, есть ещё']
  ])('подпись: %s', async (_name, props, expected) => {
    await render(props)
    expect(text()).toContain(expected)
  })

  it('список лидов подписан лидами, колонки суммы нет', async () => {
    await render({ payload: { ...PAYLOAD, entity: 'lead' } })
    expect(text()).toContain('лидов: 2')
    expect(text()).toContain('Лид')
    expect(text()).not.toContain('Сумма')
  })

  /**
   * ⚠ Пока идёт ПЕРВАЯ страница, показывать нечего — и «Показать ещё» тут приглашает в пустоту.
   * Прежняя редакция оставляла на экране только эту кнопку: ни строк, ни слова о том, что читаем.
   */
  it('первая страница ещё идёт — «Читаем записи…», а не пустой экран с кнопкой', async () => {
    await render({ rows: [], pending: true, done: false })
    expect(text()).toContain('Читаем записи…')
    expect(text()).not.toContain('Записей нет')
  })

  it('прочитано и пусто — «Записей нет»', async () => {
    await render({ rows: [], done: true })
    expect(text()).toContain('Записей нет')
  })

  it('ошибки списка и карточки показываются плашками', async () => {
    await render({ error: 'портал устал', openError: 'карточка не открылась' })
    expect(text()).toContain('Не удалось прочитать записи')
    expect(text()).toContain('портал устал')
    expect(text()).toContain('карточка не открылась')
  })

  it('клик по названию просит открыть карточку ЭТОЙ строки', async () => {
    const view = await render()
    const cells = Array.from(document.body.querySelectorAll('tbody button'))
    cells[0]?.dispatchEvent(new Event('click'))
    await view.vm.$nextTick()
    expect(view.emitted('open')?.[0]).toEqual([rows[0]])
  })

  it('дочитанный список кнопки «Показать ещё» не предлагает', async () => {
    await render({ done: true })
    expect(text()).not.toContain('Показать ещё')
  })

  /**
   * ⚠ Автоподгрузка по прокрутке была у панели и обязана остаться здесь: «Лиды» за квартал — две
   * сотни страниц, и без наблюдателя это две сотни нажатий. Дочитанный или читающий список
   * следующую страницу не просит: иначе наблюдатель вызвал бы вторую страницу с тем же курсором.
   */
  it('конец списка показался на экране — просит следующую страницу; дочитанный и читающий молчат', async () => {
    const original = window.IntersectionObserver
    let fire: (() => void) | undefined
    window.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        fire = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }

      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }

      root = null
      rootMargin = ''
      thresholds = []
    } as unknown as typeof IntersectionObserver
    try {
      const view = await render({ done: false })
      fire?.()
      expect(view.emitted('more')).toHaveLength(1)

      await view.setProps({ pending: true })
      fire?.()
      expect(view.emitted('more')).toHaveLength(1)
    } finally {
      window.IntersectionObserver = original
    }
  })
})
