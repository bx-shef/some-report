// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerDistribution from '~/components/ManagerDistribution.vue'
import { cellKey, companyKey, COMPANY_UNSET, pairKey } from '~/utils/managerLoad'
import { buildFixtureReport } from './managerFixtures'

/**
 * Блок «Распределение»: крупная кольцевая диаграмма и столбик чисел рядом — так был устроен
 * прежний отчёт заказчика на самом портале.
 *
 * ⚠ Проверяем не «нарисовалось ли красиво», а то, что ломается молча: совпадают ли числа
 * диаграммы с числами таблицы и открывает ли клик по сектору ТОТ ЖЕ список, что и число.
 */
const REPORT = buildFixtureReport()

async function mount() {
  return mountSuspended(ManagerDistribution, {
    props: { report: REPORT, totalStages: 6, scopeLabel: 'В работе' }
  })
}

describe('ManagerDistribution', () => {
  it('рисует кольца и подписывает их числами в легенде', async () => {
    const wrapper = await mount()
    // Секторов больше, чем компаний: кольца менеджеров и стадий — тоже дуги.
    expect(wrapper.findAll('svg path').length).toBeGreaterThan(REPORT.companies.length)
    const text = wrapper.text()
    expect(text).toContain('Распределение')
    // В легенде — имена компаний и их числа; группа без компании названа полным именем.
    for (const company of REPORT.companies) {
      const label = company.companyId === COMPANY_UNSET ? 'Без моей компании' : company.companyName
      expect(text).toContain(`${label}: ${company.total}`)
    }
  })

  // «Статистика» — тот же столбик чисел, что стоял рядом с диаграммой в прежнем отчёте.
  it('рядом с диаграммой — статистика словами', async () => {
    const text = (await mount()).text()
    expect(text).toContain('Сделок')
    expect(text).toContain('В работе')
    expect(text).toContain('Менеджеров')
    expect(text).toContain('Моих компаний')
    expect(text).toContain('Стадий в таблице')
    expect(text).toContain('из 6 в направлении')
  })

  it('в центре кольца — итог отбора', async () => {
    expect((await mount()).text()).toContain(String(REPORT.total))
  })

  /**
   * Клик по сектору = клик по числу в таблице.
   *
   * ⚠ Ради этого ключи узлов диаграммы совпадают с ключами счётчиков ядра: своего соответствия
   * «сектор → условие списка» здесь нет, и разойтись ему с таблицей негде.
   */
  it('клик по кольцу компании открывает список этой компании', async () => {
    const wrapper = await mount()
    const company = REPORT.companies[0]!
    const arcs = wrapper.findAll('svg path')
    await arcs[0]!.trigger('click')
    expect(wrapper.emitted('drill')?.at(-1)?.[0]).toEqual({
      companyId: company.companyId,
      title: `Сделки: ${company.companyName}`,
      total: company.total
    })
  })

  it('клик по числу в легенде открывает тот же список', async () => {
    const wrapper = await mount()
    const company = REPORT.companies[0]!
    const number = wrapper.findAll('button').find(button => button.text() === String(company.total))!
    await number.trigger('click')
    expect(wrapper.emitted('drill')?.at(-1)?.[0]).toMatchObject({ companyId: company.companyId, total: company.total })
  })

  // Клавиатура: сектор — это кнопка, и открываться список обязан не только мышью.
  it('сектор открывается с клавиатуры', async () => {
    const wrapper = await mount()
    await wrapper.findAll('svg path')[0]!.trigger('keydown.enter')
    expect(wrapper.emitted('drill')).toBeTruthy()
  })

  it('в дереве есть кольца менеджеров и стадий с теми же ключами, что у счётчиков', async () => {
    const wrapper = await mount()
    const company = REPORT.companies[0]!
    const row = company.rows[0]!
    const stageId = Object.keys(row.byStage)[0]!
    const labels = wrapper.findAll('svg path title').map(node => node.text())
    expect(labels.some(label => label.startsWith(company.companyName))).toBe(true)
    expect(labels.some(label => label.includes(row.managerName))).toBe(true)
    // Ключи ядра — те же, что у клеток матрицы: диаграмма и таблица спрашивают одно и то же.
    expect(companyKey(company.companyId)).toBe(`mc|${company.companyId}`)
    expect(pairKey(company.companyId, row.managerId)).toContain(String(row.managerId))
    expect(cellKey(company.companyId, row.managerId, stageId)).toContain(stageId)
  })

  it('пустой отчёт не рисует круг из ничего и говорит словами', async () => {
    const wrapper = await mountSuspended(ManagerDistribution, {
      props: {
        report: { ...REPORT, companies: [], stages: [], total: 0, managers: 0, companyCount: 0, byStage: {}, unlisted: 0, otherStages: 0 },
        totalStages: 6,
        scopeLabel: 'В работе'
      }
    })
    expect(wrapper.findAll('svg path')).toHaveLength(0)
    expect(wrapper.text()).toContain('Под этим отбором сделок нет')
  })

  // ⚠ В легенде группа без компании зовётся «Без моей компании»: рядом нет заголовка «Моя
  // компания», и короткое «Не указана» читалось бы как «что не указана?».
  it('группу без «моей компании» в легенде называет полным именем', async () => {
    const wrapper = await mount()
    expect(REPORT.companies.some(company => company.companyId === COMPANY_UNSET)).toBe(true)
    expect(wrapper.text()).toContain('Без моей компании')
  })
})
