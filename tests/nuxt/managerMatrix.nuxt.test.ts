// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerMatrix from '~/components/ManagerMatrix.vue'
import type { ManagerCellRef } from '~/types/managers'
import { buildFixtureReport } from './managerFixtures'

/**
 * Матрица «компания → менеджер → стадия». Проверяем то, что ломается молча: какие числа кликабельны,
 * что именно уходит в список за числом и видна ли строка «сделки вне таблицы».
 *
 * ⚠ Раскладок ДВЕ: до `md` — карточка на менеджера, с `md` — таблица. В happy-dom брейкпоинты не
 * работают (там нет ни ширины окна, ни CSS), поэтому в разметке присутствуют ОБЕ, и проверить
 * «что видно на телефоне» отсюда нельзя. Что проверить можно и нужно — что мобильная раскладка
 * несёт ТЕ ЖЕ числа и открывает ТОТ ЖЕ список: молча теряются именно они, а не классы.
 */
const report = buildFixtureReport()

async function mount() {
  return mountSuspended(ManagerMatrix, { props: { report } })
}

/**
 * Матрица ВНУТРИ страницы, которая объявила детализацию выключенной, — то есть вне портала или на
 * демо-наборе.
 *
 * ⚠ Обёртка нужна потому, что ответ приходит инъекцией ОТ СТРАНИЦЫ (`useDrillEnabled`), а не из
 * пропсов. Без неё умолчание — «кликабельно», и ни один тест матрицы никогда не видел выключенного
 * состояния: ровно поэтому исторический дефект «вне портала пропадало само число» и жил незамеченным.
 */
async function mountDisabled() {
  const Host = defineComponent({
    setup() {
      provideDrillEnabled(computed(() => false))
      return () => h(ManagerMatrix, { report })
    }
  })
  return mountSuspended(Host)
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

  /**
   * ⚠ Мобильная раскладка не имеет права быть «версией попроще»: числа в ней те же, что в
   * таблице, и открывают тот же список. Проверяем это по СПИСКУ карточек, а не по тексту всего
   * компонента — иначе тест был бы зелёным и при полностью пустой мобильной раскладке, потому
   * что рядом стоит таблица с теми же словами.
   */
  it('карточки телефона несут те же числа, что таблица', async () => {
    const wrapper = await mount()
    const cards = wrapper.findAll('ul > li')
    // Строка на менеджера + строка остатка + итог компании.
    expect(cards.length).toBeGreaterThanOrEqual(report.companies[0]!.rows.length + 1)
    const first = cards[0]!
    expect(first.text()).toContain('Иванов Иван')
    expect(first.text()).toContain(String(report.companies[0]!.rows[0]!.total))
  })

  it('клик по числу в карточке телефона открывает тот же список, что и в таблице', async () => {
    const wrapper = await mount()
    const inCard = wrapper.findAll('ul > li')[0]!.findAll('button')
    expect(inCard.length).toBeGreaterThan(0)
    await inCard[0]!.trigger('click')
    const fromCard = wrapper.emitted('drill')?.[0]?.[0] as ManagerCellRef

    const row = report.companies[0]!.rows[0]!
    expect(fromCard).toMatchObject({
      companyId: report.companies[0]!.companyId,
      managerId: row.managerId,
      total: row.total
    })
    // ⚠ И тот же заголовок, что у таблицы: разойдись они, одно и то же число открывало бы список
    // с разными подписями в зависимости от ширины экрана.
    expect(fromCard.title).toContain('Иванов Иван')
  })

  /**
   * ⚠ Вне портала ЧИСЛО ОСТАЁТСЯ, пропадает только ссылка. Спрятать число значило бы соврать, что
   * сделок нет. Этот дефект в проекте уже был: ветку «число есть, но не кликабельно» теряли в двух
   * копиях разметки из четырёх, и ни один тест этого не видел, потому что выключенного состояния
   * ни один тест не создавал.
   */
  it('детализация выключена — числа остаются текстом, а кнопок нет', async () => {
    const wrapper = await mountDisabled()
    expect(wrapper.findAll('button')).toHaveLength(0)
    const row = report.companies[0]!.rows[0]!
    const text = wrapper.text()
    expect(text).toContain(row.managerName)
    // Само число на месте — и в таблице, и в карточке телефона.
    expect(text).toContain(String(row.total))
    expect(text).toContain('Итого по компании')
  })

  it('у работающего сотрудника пометки нет', async () => {
    const rows = (await mount()).findAll('tbody tr')
    expect(rows[0]!.text()).not.toContain('уволен')
  })
})
