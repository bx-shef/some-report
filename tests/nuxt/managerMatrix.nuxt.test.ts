// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerMatrix from '~/components/ManagerMatrix.vue'
import type { ManagerCellRef } from '~/types/managers'
import { buildFixtureReport } from './managerFixtures'

/**
 * Матрица «компания → менеджер → стадия». Проверяем то, что ломается молча: какие числа кликабельны,
 * что именно уходит в список за числом и видна ли строка «сделки вне таблицы».
 */
const report = buildFixtureReport()

async function mount() {
  return mountSuspended(ManagerMatrix, { props: { report } })
}

describe('ManagerMatrix', () => {
  it('рисует карточку на компанию и строку на менеджера', async () => {
    const wrapper = await mount()
    const text = wrapper.text()
    expect(text).toContain('Минск')
    expect(text).toContain('Иванов Иван')
    expect(text).toContain('Итого по компании')
  })

  it('колонки — только стадии отчёта, плюс «Всего»', async () => {
    const headers = (await mount()).findAll('table')[0]!.findAll('thead th').map(th => th.text())
    expect(headers).toEqual(['Менеджер', 'Новая', 'Выставлен счёт', 'Всего'])
  })

  it('клик по клетке уходит списком ровно за это число', async () => {
    const wrapper = await mount()
    const button = wrapper.findAll('tbody button').find(b => b.attributes('title')?.includes('Иванов Иван, Новая'))
    await button!.trigger('click')
    const cell = wrapper.emitted('drill')?.[0]?.[0] as ManagerCellRef
    expect(cell).toMatchObject({ companyId: 10, managerId: 1, stageId: 'NEW', total: 5 })
    expect(cell.title).toBe('Сделки: Минск · Иванов Иван · Новая')
  })

  it('итог строки — список без стадии, итог компании — без менеджера', async () => {
    const wrapper = await mount()
    const rowTotal = wrapper.findAll('tbody button').find(b => b.attributes('title')?.includes('все сделки, Иванов Иван'))
    await rowTotal!.trigger('click')
    expect(wrapper.emitted('drill')?.[0]?.[0]).toMatchObject({ companyId: 10, managerId: 1, total: 12 })
    expect((wrapper.emitted('drill')?.[0]?.[0] as ManagerCellRef).stageId).toBeUndefined()

    // Именно ПЕРВОЙ карточки: `tfoot` есть у каждого компании, и последняя — «не указана».
    const companyTotal = wrapper.findAll('table')[0]!.findAll('tfoot button').at(-1)
    await companyTotal!.trigger('click')
    const company = wrapper.emitted('drill')?.[1]?.[0] as ManagerCellRef
    expect(company).toMatchObject({ companyId: 10, total: 25 })
    expect(company.managerId).toBeUndefined()
  })

  // Пустая клетка — не ноль и не кнопка: списка за ней нет, и притворяться ссылкой она не должна.
  it('пустая клетка — прочерк, а не кнопка с нулём', async () => {
    const wrapper = await mount()
    // Петров: 8 в «Новая», в «Выставлен счёт» пусто — значит кнопок две (клетка и «Всего»).
    const row = wrapper.findAll('table')[0]!.findAll('tbody tr')[1]!
    expect(row.text()).toContain('—')
    expect(row.findAll('button')).toHaveLength(2)
  })

  it('сделки компании вне строк показаны отдельной строкой с объяснением', async () => {
    const text = (await mount()).text()
    expect(text).toContain('Ответственный не указан или не найден')
    expect(text).toContain('разница между итогом компании и суммой строк')
  })
})
