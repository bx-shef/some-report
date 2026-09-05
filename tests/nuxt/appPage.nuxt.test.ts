// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import AppPage from '~/pages/app/leads.vue'
import ReportFilters from '~/components/ReportFilters.vue'

/** Библиотеки экспорта подменены: страница обязана отдать снимку САМ корень отчёта. */
const exportLib = vi.hoisted(() => ({ snapshot: undefined as HTMLElement | undefined }))
vi.mock('html-to-image', () => ({
  toJpeg: async (element: HTMLElement) => {
    exportLib.snapshot = element
    return 'data:image/jpeg;base64,AAAA'
  },
  getFontEmbedCSS: async () => ''
}))
vi.mock('jspdf', () => ({
  jsPDF: class {
    addImage() {}
    output() { return new Blob(['pdf']) }
  }
}))

/**
 * Экран отчёта до и после первой выборки.
 *
 * ⚠ Решение владельца от 2026-09-04: пока портал не ответил, на экране только «Загрузка» — ни
 * демо-чисел, ни значка «Демо-данные», ни периода демо-набора. Руководитель читает числа раньше
 * плашек, и «1 250 лидов», которых у него нет, однажды уже приняли за свои. Состояние живёт в
 * самой странице, поэтому проверяется монтированием страницы, а не композабла.
 */
const portal = vi.hoisted(() => ({
  initialized: true,
  /** Сколько лидов «нашёл» портал: ноль под фильтром — подсказка про фильтр, не про портал. */
  leadTotal: 7,
  /** Отложенный ответ построчной выборки: тест сам решает, когда портал «ответил». */
  pending: {} as Record<string, (rows: unknown[]) => void>,
  /** Портал отвечает ошибкой на первый же пакет. */
  batchThrows: false,
  batchCalls: 0,
  /** Настройки пользователя, которые «помнит» портал (`user.option.get`). */
  options: {} as Record<string, unknown>,
  /** Что отчёт записал в настройки (`user.option.set`). */
  optionWrites: [] as Array<Record<string, unknown>>
}))

function batchAnswer(commands: Record<string, unknown>) {
  const data: Record<string, { getTotal: () => number, getData: () => { result: unknown[] } }> = {}
  for (const key of Object.keys(commands)) {
    data[key] = { getTotal: () => (key === 'total' ? portal.leadTotal : 0), getData: () => ({ result: [] }) }
  }
  return { isSuccess: true, getData: () => data, getErrorMessages: () => [] }
}

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => portal.initialized,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {},
  getOrThrow: () => ({
    actions: {
      v2: {
        batch: {
          make: async ({ calls }: { calls: Record<string, unknown> }) => {
            portal.batchCalls++
            if (portal.batchThrows) throw new Error('портал недоступен')
            return batchAnswer(calls)
          }
        },
        call: {
          make: ({ method, params }: { method: string, params: { filter?: Record<string, string>, options?: Record<string, unknown> } }) => {
            if (method === 'user.option.get') {
              return Promise.resolve({ isSuccess: true, getData: () => ({ result: portal.options }), getErrorMessages: () => [] })
            }
            if (method === 'user.option.set') {
              portal.optionWrites.push(params.options ?? {})
              return Promise.resolve({ isSuccess: true, getData: () => ({ result: true }), getErrorMessages: () => [] })
            }
            // Справка блока 7 (фоном, по дате закрытия) — своим курсором через `call`.
            if (method === 'crm.deal.list') {
              return new Promise((resolve) => {
                portal.pending[`closed:${params.filter?.['>=CLOSEDATE'] ?? '?'}`] = rows => resolve({ isSuccess: true, getData: () => ({ result: rows }), getErrorMessages: () => [] })
              })
            }
            return Promise.resolve({ isSuccess: true, getData: () => ({ result: { categories: [] } }), getErrorMessages: () => [] })
          }
        },
        callList: {
          make: ({ params }: { params: { filter: Record<string, string> } }) => new Promise((resolve) => {
            portal.pending[params.filter['>=DATE_CREATE'] ?? '?'] = rows => resolve({ isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
          })
        }
      }
    }
  })
}))

beforeEach(() => {
  portal.initialized = true
  portal.leadTotal = 7
  portal.pending = {}
  portal.batchThrows = false
  portal.batchCalls = 0
  portal.options = {}
  portal.optionWrites = []
})

describe('страница отчёта в портале', () => {
  /** Ключи ОСНОВНЫХ выборок (сделки из лидов), без фоновой справки блока 7. */
  const mainKeys = () => Object.keys(portal.pending).filter(key => !key.startsWith('closed:'))

  it('до ответа портала — только «Загрузка», после — отчёт', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))

    const before = wrapper.text()
    expect(before).toContain('Загрузка')
    expect(before).not.toContain('Сводка')
    // Панель фильтров — тоже после первой выборки: смена фильтра до неё слала бы второй запрос.
    expect(before).not.toContain('Фильтры:')
    // И кнопки экспорта: выгружать нечего, пока чисел нет.
    expect(wrapper.findAll('button').some((b: { text: () => string }) => b.text() === 'Excel')).toBe(false)
    expect(before).not.toContain('Демо-данные')
    expect(before).not.toContain('Это НЕ данные вашего портала')
    // Период демо-набора (август) на панели не показывается — только выбранный.
    expect(before).not.toContain('01.08.2026')

    portal.pending[mainKeys()[0]!]!([])
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('Загрузка…'))
    const after = wrapper.text()
    expect(after).toContain('1. Сводка')
    expect(after).toContain('Фильтры:')
    expect(wrapper.findAll('button').some((b: { text: () => string }) => b.text() === 'Excel')).toBe(true)
    expect(wrapper.findAll('button').some((b: { text: () => string }) => b.text() === 'PDF')).toBe(true)
    expect(after).not.toContain('Демо-данные')
    // Справка блока 7 ещё считается — и говорит об этом сама, не задерживая отчёт.
    expect(after).toContain('Считаем успешные сделки без лида')
  })

  // ⚠ Кнопки периода живые и во время первой выборки, а наблюдатель периода в это время молчит.
  // Без досылки выборки после загрузки подсветка показывала бы «Прошлый месяц» над числами
  // текущего, и второй клик по той же кнопке ничего не менял бы.
  it('период, выбранный во время первой выборки, дозапрашивается после неё', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
    const firstFrom = mainKeys()[0]!

    const prevMonth = wrapper.findAll('button').find((b: { text: () => string }) => b.text() === 'Прошлый месяц')!
    await prevMonth.trigger('click')
    // Пока первая выборка идёт, второй запрос не уходит.
    expect(mainKeys()).toHaveLength(1)

    portal.pending[firstFrom]!([])
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(2))
    const secondFrom = mainKeys().find(key => key !== firstFrom)!
    expect(secondFrom < firstFrom).toBe(true)

    portal.pending[secondFrom]!([])
    // Подпись периода на панели — по загруженным данным, то есть по прошлому месяцу.
    await vi.waitFor(() => expect(wrapper.text()).toContain(`${secondFrom.slice(8, 10)}.${secondFrom.slice(5, 7)}.${secondFrom.slice(0, 4)}`))
    expect(wrapper.text()).not.toContain('Загрузка…')
  })

  // ⚠ При ошибке набор остаётся демонстрационным со своим периодом. Сравнение «выбранный период
  // против периода набора» слало бы второй запрос в упавший портал — без единого клика.
  it('ошибка портала — один запрос, плашка об ошибке и демо-набор, а не повтор', async () => {
    portal.batchThrows = true
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(wrapper.text()).toContain('Не удалось прочитать данные портала'))
    expect(portal.batchCalls).toBe(1)
    expect(wrapper.text()).toContain('Показан демонстрационный набор')
    expect(wrapper.text()).toContain('Это НЕ данные вашего портала')
  })

  // Под фильтром пустота объяснима самим фильтром, а причина проигрыша по построению обнуляет
  // продажи — оба случая экран обязан подписать, иначе читаются как поломка отчёта.
  it('под фильтром: пустой период — про фильтр, причина проигрыша — плашка, блок 7 подписан', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
    const from = mainKeys()[0]!
    portal.pending[from]!([])
    await vi.waitFor(() => expect(wrapper.text()).toContain('1. Сводка'))

    portal.leadTotal = 0
    wrapper.findComponent(ReportFilters).vm.$emit('update:modelValue', { sourceId: 'CALL' })
    await vi.waitFor(() => expect(wrapper.text()).toContain('Читаем лиды и сделки портала…'))
    portal.pending[from]!([])
    await vi.waitFor(() => expect(wrapper.text()).toContain('Под выбранными фильтрами за этот период лидов нет'))
    expect(wrapper.text()).not.toContain('Последний лид создан')
    expect(wrapper.text()).toContain('Фильтры отчёта здесь не действуют')
    expect(wrapper.text()).not.toContain('Успешных сделок под этим фильтром не бывает')

    portal.leadTotal = 7
    wrapper.findComponent(ReportFilters).vm.$emit('update:modelValue', { lossReasonKey: 'дорого' })
    await vi.waitFor(() => expect(wrapper.text()).toContain('Читаем лиды и сделки портала…'))
    portal.pending[from]!([])
    await vi.waitFor(() => expect(wrapper.text()).toContain('Успешных сделок под этим фильтром не бывает'))
    expect(wrapper.text()).not.toContain('Под выбранными фильтрами')
  })

  // Детализация по клику: слайдер с заголовком числа. В портале список читается страницами,
  // в демо — из строк макета; карточек CRM у демо-строк нет, и слайдер об этом говорит.
  it('клик по числу открывает слайдер: в портале — список по запросу, в демо — строки макета', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
    portal.pending[mainKeys()[0]!]!([])
    await vi.waitFor(() => expect(wrapper.text()).toContain('1. Сводка'))
    const leads = wrapper.findAll('button').find((b: { attributes: (name: string) => string | undefined }) => b.attributes('title') === 'Открыть список: Лиды')!
    await leads.trigger('click')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Записей нет'))
    wrapper.unmount()

    portal.initialized = false
    const demo = await mountSuspended(AppPage, { route: '/app?preview=1' })
    await vi.waitFor(() => expect(demo.text()).toContain('Это НЕ данные вашего портала'))
    const junk = demo.findAll('button').find((b: { attributes: (name: string) => string | undefined }) => b.attributes('title') === 'Открыть список: Брак лидов')!
    await junk.trigger('click')
    await vi.waitFor(() => expect(document.body.textContent).toContain('карточек в CRM у них нет'))
    expect(document.body.textContent).toContain('Лид #')
    demo.unmount()
  })

  // Единственное, чего не видит тест композабла: `ref="reportRoot"` на <main> доходит до снимка.
  it('кнопка PDF отдаёт снимку корень отчёта, пока идёт экспорт — кнопки закрыты', async () => {
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 1000 })
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 2000 })
    try {
      const wrapper = await mountSuspended(AppPage)
      await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
      portal.pending[mainKeys()[0]!]!([])
      await vi.waitFor(() => expect(wrapper.text()).toContain('1. Сводка'))
      const pdf = wrapper.findAll('button').find((b: { text: () => string }) => b.text() === 'PDF')!
      await pdf.trigger('click')
      await vi.waitFor(() => expect(exportLib.snapshot?.tagName).toBe('MAIN'))
      await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1))
      expect(wrapper.text()).not.toContain('Не удалось подготовить файл')
    } finally {
      vi.unstubAllGlobals()
      click.mockRestore()
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
    }
  })

  /**
   * Отбор, запомненный порталом за человеком (`user.option`).
   *
   * ⚠ Читается ДО первой выборки: иначе портал считал бы месяц дважды — сначала по умолчанию,
   * потом по восстановленному отбору. Проверяем именно по ключу запроса: он равен началу
   * периода, с которым отчёт пошёл в портал.
   */
  it('открывается с периодом и фильтрами, запомненными в прошлый раз', async () => {
    portal.options['report.leads.v1'] = JSON.stringify({
      period: { from: '2026-07-01', to: '2026-07-31' },
      filters: { sourceId: 'CALL' }
    })
    await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
    expect(mainKeys()[0]).toBe('2026-07-01')
  })

  // Негодную настройку (перевёрнутый период) отчёт молча не берёт: отбор, которого человек не
  // выбирал, он стал бы искать в данных.
  it('негодный сохранённый период не применяется', async () => {
    portal.options['report.leads.v1'] = JSON.stringify({ period: { from: '2026-09-30', to: '2026-09-01' } })
    await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
    expect(mainKeys()[0]).not.toBe('2026-09-30')
  })

  it('смена периода запоминается в портале', async () => {
    const wrapper = await mountSuspended(AppPage)
    await vi.waitFor(() => expect(mainKeys()).toHaveLength(1))
    portal.pending[mainKeys()[0]!]!([])
    await vi.waitFor(() => expect(wrapper.text()).toContain('1. Сводка'))

    const previous = wrapper.findAll('button').find((b: { text: () => string }) => b.text() === 'Прошлый месяц')!
    await previous.trigger('click')
    await vi.waitFor(() => expect(portal.optionWrites).toHaveLength(1))
    // ⚠ Границы считаем в тесте от «сегодня», а не пишем датами: иначе тест начал бы падать в
    // первый день следующего месяца, и виноват был бы календарь, а не код.
    const now = new Date()
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    expect(JSON.parse(String(portal.optionWrites[0]!['report.leads.v1']))).toMatchObject({
      period: { from: iso(first), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) }
    })
  })

  it('вне портала «Загрузка» сменяется демо-набором с предупреждением', async () => {
    portal.initialized = false
    const wrapper = await mountSuspended(AppPage, { route: '/app?preview=1' })
    await vi.waitFor(() => expect(wrapper.text()).toContain('Это НЕ данные вашего портала'))
    expect(wrapper.text()).toContain('Демо-данные')
    expect(wrapper.text()).not.toContain('Загрузка…')
  })
})
