// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import AppIndex from '~/pages/app/index.vue'
import type { DrillSliderPayload } from '~/utils/drillSlider'

/**
 * Главная приложения — страница с ДВУМЯ лицами: оглавление по плитке «Приложения» и СПИСОК
 * детализации во фрейме слайдера (`openSliderAppPage` открывает зарегистрированный адрес `/app`).
 *
 * ⛔ Сторожит она ровно то, что ломалось на боевом портале ТРИЖДЫ: высоту фрейма. Подгонка под
 * содержимое (`fitWindow`) нужна оглавлению — там три плитки, и фрейм в целый экран оставил бы
 * под ними пустое поле. А списку она вредит: портал открывает слайдер высотой в экран, подгонка
 * схлопывала его до размера содержимого, и НАСТОЯЩИЙ слайдер выглядел модальным окошком посреди
 * экрана. Девять сделок давали окно на треть экрана, сотня лидов — нормальное, и читалось это
 * однозначно: «открылся не тот слайдер».
 */
const portal = vi.hoisted(() => ({
  /** Сколько раз страница просила портал подогнать высоту фрейма. */
  fits: 0,
  /** Фрейм открыт КАК детализация. */
  asDrill: false,
  /** Нагрузка разобралась. `false` — портал прислал негодное условие. */
  payloadOk: true,
  /** Что показал список (заглушка композабла: портал здесь ни при чём). */
  started: [] as DrillSliderPayload[]
}))

const PAYLOAD: DrillSliderPayload = {
  entity: 'deal',
  title: 'Успешные сделки из лидов',
  filter: { 'STAGE_SEMANTIC_ID': 'S', '!LEAD_ID': null },
  dealScope: 'from-leads',
  total: 9
}

mockNuxtImport('useB24', () => () => ({
  init: async () => {},
  isInit: () => true,
  targetOrigin: () => 'https://example.bitrix24.by',
  getRequiredRights: () => [],
  fitWindow: async () => {
    portal.fits++
  },
  openPath: async () => true
}))

mockNuxtImport('usePortalSlider', () => () => ({
  openDrill: async () => ({ opened: true }),
  drillRequested: () => portal.asDrill,
  // ⚠ Условие читается ТОЛЬКО у фрейма детализации: у обычного открытия в `user.option` нашего
  // ключа нет вовсе. Стенд, отдающий нагрузку всегда, показал бы список там, где человек ждёт
  // оглавление, — и тест проверял бы не тот экран.
  readDrill: async () => (!portal.asDrill
    ? { ok: false as const, reason: 'не детализация' }
    : portal.payloadOk
      ? { ok: true as const, payload: PAYLOAD }
      : { ok: false as const, reason: 'условие устарело' })
}))

mockNuxtImport('useDrillPage', () => () => ({
  rows: ref([{ id: 1, title: 'Заказ покупателя 00КА-69778' }]),
  pending: ref(false),
  error: ref(undefined),
  done: ref(true),
  start: async (payload: DrillSliderPayload) => {
    portal.started.push(payload)
  },
  loadMore: async () => {}
}))

beforeEach(() => {
  portal.fits = 0
  portal.asDrill = false
  portal.payloadOk = true
  portal.started = []
})

describe('главная приложения', () => {
  /**
   * ⛔ Главная проверка. Вернётся подгонка высоты для списка — слайдер снова станет окошком, и
   * заметит это только человек на боевом портале: на демо-наборе детализации нет вовсе, а
   * `fitWindow` вне фрейма — пустая операция.
   */
  it('во фрейме слайдера высоту фрейма НЕ подгоняет — слайдер остаётся во весь экран', async () => {
    portal.asDrill = true
    const wrapper = await mountSuspended(AppIndex)
    expect(portal.started).toEqual([PAYLOAD])
    expect(wrapper.text()).toContain('Успешные сделки из лидов')
    // ⚠ Ждём ТОТ ЖЕ такт, на котором оглавление успевает подогнать высоту: иначе ноль здесь
    // означал бы «ещё не успели», а не «не подгоняем».
    await vi.waitFor(() => expect(portal.started).toHaveLength(1))
    await nextTick()
    expect(portal.fits).toBe(0)
  })

  /** А оглавлению подгонка нужна: три плитки в целом экране оставили бы под собой пустое поле. */
  it('оглавление приложения высоту фрейма подгоняет', async () => {
    const wrapper = await mountSuspended(AppIndex)
    expect(portal.started).toEqual([])
    expect(wrapper.text()).toContain('Аналитика по лидам')
    // ⚠ Подгонка идёт после `nextTick`, то есть ПОЗЖЕ монтирования: без ожидания тест проверял бы
    // момент, когда её ещё не случилось, и «не подгоняет» было бы истиной для обоих экранов.
    await vi.waitFor(() => expect(portal.fits).toBe(1))
  })

  /**
   * ⚠ Негодное условие — тоже экран ВО ФРЕЙМЕ СЛАЙДЕРА, и высоту ему подгонять так же нельзя:
   * плашка отказа занимает две строки, и слайдер сжался бы до них. Прежде так и было.
   */
  it('негодное условие называет причину и высоту фрейма тоже не трогает', async () => {
    portal.asDrill = true
    portal.payloadOk = false
    const wrapper = await mountSuspended(AppIndex)
    expect(wrapper.text()).toContain('Список не открылся')
    expect(wrapper.text()).toContain('условие устарело')
    await nextTick()
    expect(portal.fits).toBe(0)
  })
})
