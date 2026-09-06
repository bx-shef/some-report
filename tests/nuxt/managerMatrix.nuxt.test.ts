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
    // ⚠ Подпись называет НАСТОЯЩУЮ причину: ответственный у сделки обязателен, значит сделка
    // выпала из строк только потому, что её сотрудник не попал в перечисление.
    expect(text).toContain('Ответственный не попал в перечисление')
    expect(text).toContain('разница между итогом компании и суммой строк')
    expect(text).not.toContain('не назначен ответственный')
  })

  /**
   * ⚠ Доли «от всех» в шапке карточки НЕТ (решение владельца 2026-09-06): компанию выбирает
   * фильтр, компания на экране одна, итог отбора равен итогу компании — значит, доля всегда
   * 100 %, в любой выборке. Число, которое не меняется никогда, не сообщает ничего.
   */
  it('в шапке карточки — только число сделок, без доли «от всех»', async () => {
    const text = (await mount()).text()
    expect(text).toContain('сделок:')
    expect(text).not.toContain('от всех')
  })

  /**
   * ⚠ Уволенного помечаем СЛОВОМ, а не только приглушённым цветом: «почему эта строка бледнее» —
   * вопрос, на который таблица обязана отвечать сама. Сделки его при этом остаются в отчёте:
   * работа сделана, и из чисел компании она никуда не девается.
   */
  it('строку уволенного помечает словом, а его сделки оставляет в отчёте', async () => {
    const withDismissed = {
      ...report,
      companies: report.companies.map((company, index) => index > 0
        ? company
        : { ...company, rows: company.rows.map((row, at) => at === 0 ? { ...row, dismissed: true } : row) })
    }
    const wrapper = await mountSuspended(ManagerMatrix, { props: { report: withDismissed } })
    const first = wrapper.findAll('tbody tr')[0]!
    expect(first.text()).toContain('Иванов Иван')
    expect(first.text()).toContain('уволен')
    // Число осталось кликабельным: список сделок уволенного собирается тем же фильтром.
    expect(first.findAll('button.drill-number').length).toBeGreaterThan(0)
  })

  it('у работающего сотрудника пометки нет', async () => {
    const rows = (await mount()).findAll('tbody tr')
    expect(rows[0]!.text()).not.toContain('уволен')
  })
})
