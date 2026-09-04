// @vitest-environment nuxt
import type { DefineComponent } from 'vue'
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { B24SelectMenu } from '#components'
import ReportFilters from '~/components/ReportFilters.vue'
import type { ReportFilters as Filters } from '~/types/report'
import { buildMockDataset } from '~/utils/mockReport'

/**
 * Панель фильтров: что она отдаёт наружу. Сам выпадающий список — компонент Bitrix24 UI, его
 * не проверяем; проверяем правила сборки значения, которые живут здесь.
 *
 * Компонент ищем по самому определению из `#components`. Приведение типа — потому что у
 * generic-компонента тип функции, и тайпчекер сводил бы результат к DOM-обёртке без `vm`.
 */
const SELECT = B24SelectMenu as unknown as DefineComponent
const dictionaries = buildMockDataset().dictionaries

function render(modelValue: Filters = {}, extra: Partial<{ disabled: boolean }> = {}, dict = dictionaries) {
  return mountSuspended(ReportFilters, { props: { dictionaries: dict, modelValue, ...extra } })
}

async function pickAt(wrapper: Awaited<ReturnType<typeof render>>, index: number, value: unknown) {
  const menus = wrapper.findAllComponents(SELECT)
  menus[index]!.vm.$emit('update:modelValue', value)
  await wrapper.vm.$nextTick()
  return wrapper.emitted('update:modelValue')?.at(-1)?.[0]
}

describe('ReportFilters', () => {
  it('пять фильтров с подписями; кнопки «Сбросить» без выбора нет', async () => {
    const wrapper = await render()
    expect(wrapper.findAllComponents(SELECT)).toHaveLength(5)
    for (const label of ['Источник', 'Менеджер', 'Стадия лида', 'Причина закрытия лида', 'Причина проигрыша сделки']) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists(), label).toBe(true)
    }
    expect(wrapper.findAll('button').some((b: { text: () => string }) => b.text().includes('Сбросить'))).toBe(false)
  })

  it('выбор источника и менеджера — в модель; «очистить» убирает ключ, а не оставляет null', async () => {
    const wrapper = await render()
    expect(await pickAt(wrapper, 0, 'CALL')).toEqual({ sourceId: 'CALL' })
    const withUser = await render({ sourceId: 'CALL' })
    expect(await pickAt(withUser, 1, 2)).toEqual({ sourceId: 'CALL', assignedById: 2 })
    const cleared = await render({ sourceId: 'CALL', assignedById: 2 })
    expect(await pickAt(cleared, 0, null)).toEqual({ assignedById: 2 })
  })

  // ⚠ Стадия и причина закрытия — одно поле STATUS_ID: два условия на него дали бы пустой отчёт.
  it('стадия лида и причина закрытия взаимно снимают друг друга', async () => {
    const [junkId] = Object.keys(dictionaries.junkReasons)
    const fromStage = await render({ leadStatusId: 'CONVERTED' })
    expect(await pickAt(fromStage, 3, junkId)).toEqual({ junkReasonId: junkId })
    const fromReason = await render({ junkReasonId: junkId })
    expect(await pickAt(fromReason, 2, 'CONVERTED')).toEqual({ leadStatusId: 'CONVERTED' })
  })

  it('причина проигрыша — пятый список; подпись о правилах есть только при выборе', async () => {
    const wrapper = await render()
    expect(wrapper.text()).not.toContain('Менеджер — ответственный лида')
    expect(await pickAt(wrapper, 4, 'дорого')).toEqual({ lossReasonKey: 'дорого' })
    const active = await render({ lossReasonKey: 'дорого' })
    expect(active.text()).toContain('Менеджер — ответственный лида')
    expect(active.text()).toContain('выбор одного снимает другое')
  })

  // Пока идёт выборка, менять фильтры нельзя: каждая смена — новый запрос к порталу.
  it('disabled закрывает все пять списков и кнопку «Сбросить»', async () => {
    const wrapper = await render({ sourceId: 'CALL' }, { disabled: true })
    for (const menu of wrapper.findAllComponents(SELECT)) expect((menu.props() as Record<string, unknown>).disabled).toBe(true)
    const button = wrapper.findAll('button').find((b: { text: () => string }) => b.text().includes('Сбросить'))!
    expect(button.attributes('disabled')).toBeDefined()
  })

  it('«Сбросить» отдаёт пустые фильтры', async () => {
    const wrapper = await render({ sourceId: 'CALL', lossReasonKey: 'X' })
    const button = wrapper.findAll('button').find((b: { text: () => string }) => b.text().includes('Сбросить'))!
    await button.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({})
  })

  // Права `user_brief` может не быть — тогда список пуст, и выбор менеджера закрыт с объяснением.
  it('без списка сотрудников выбор менеджера закрыт и подписан', async () => {
    const wrapper = await render({}, {}, { ...dictionaries, users: {} })
    const manager = wrapper.findAllComponents(SELECT)[1]!.props() as Record<string, unknown>
    expect(manager.disabled).toBe(true)
    expect(manager.placeholder).toContain('недоступен')
  })
})
