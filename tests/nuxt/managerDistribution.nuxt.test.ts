// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ManagerDistribution from '~/components/ManagerDistribution.vue'
import { cellKey, COMPANY_UNSET, COMPANY_UNSET_FULL_LABEL, pairKey } from '~/utils/managerLoad'
import { CHART_MANAGERS, shortManagerName } from '~/utils/managerChart'
import { buildFixtureReport } from './managerFixtures'

/**
 * Блок «Распределение»: крупная кольцевая диаграмма и столбик чисел рядом — так был устроен
 * прежний отчёт заказчика на самом портале.
 *
 * ⚠ Проверяем не «нарисовалось ли красиво», а то, что ломается молча: совпадают ли числа
 * диаграммы с числами таблицы и открывает ли клик по сектору ТОТ ЖЕ список, что и число.
 */
/**
 * Компания на экране ОДНА: её выбирает фильтр, а ядро отдаёт единственной группой. Фикстуру
 * сводим к первой компании — ровно то, что приходит в блок на живом портале.
 */
const FULL = buildFixtureReport()
const COMPANY = FULL.companies[0]!
const REPORT = {
  ...FULL,
  companies: [COMPANY],
  total: COMPANY.total,
  unlisted: COMPANY.unlisted,
  managers: COMPANY.rows.length,
  companyCount: 1
}

async function mount() {
  return mountSuspended(ManagerDistribution, {
    props: { report: REPORT, totalStages: 6, scopeLabel: 'В работе' }
  })
}

describe('ManagerDistribution', () => {
  it('рисует кольца менеджеров и стадий, в заголовке — компания', async () => {
    const wrapper = await mount()
    // Секторов больше, чем менеджеров: кольцо стадий — тоже дуги.
    expect(wrapper.findAll('svg path').length).toBeGreaterThan(COMPANY.rows.length)
    expect(wrapper.text()).toContain(`Распределение: ${COMPANY.companyName}`)
  })

  /**
   * ⚠ Имена читаются с самой диаграммы, как в прежнем отчёте заказчика, а не только из легенды.
   * В секторе — сокращённое «Фамилия И.»: полное имя туда не влезает, а обрезка по длине сделала
   * бы «Авдеева …» и «Авдеенко …» неразличимыми.
   */
  it('пишет подписи прямо в секторах', async () => {
    const wrapper = await mount()
    const labels = wrapper.findAll('svg text').map(node => node.text())
    expect(labels.length).toBeGreaterThan(0)
    expect(labels).toContain(shortManagerName(COMPANY.rows[0]!.managerName))
  })

  // Легенда — ВСЕ менеджеры компании с числами и долями.
  it('в легенде каждый менеджер со своим числом', async () => {
    const text = (await mount()).text()
    for (const row of COMPANY.rows) {
      expect(text).toContain(row.managerName)
      expect(text).toContain(String(row.total))
    }
  })

  // «Статистика» — тот же столбик чисел, что стоял рядом с диаграммой в прежнем отчёте.
  it('рядом с диаграммой — статистика словами', async () => {
    const text = (await mount()).text()
    expect(text).toContain('Сделок')
    expect(text).toContain('В работе')
    expect(text).toContain('Менеджеров')
    expect(text).toContain('Стадий')
    expect(text).toContain('из 6 в направлении')
    expect(text).toContain('Без ответственного')
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
  it('клик по кольцу менеджера открывает список его сделок', async () => {
    const wrapper = await mount()
    const row = COMPANY.rows[0]!
    await wrapper.findAll('svg path')[0]!.trigger('click')
    expect(wrapper.emitted('drill')?.at(-1)?.[0]).toEqual({
      companyId: COMPANY.companyId,
      managerId: row.managerId,
      title: `Сделки: ${COMPANY.companyName} · ${row.managerName}`,
      total: row.total
    })
  })

  it('клик по числу в легенде открывает тот же список', async () => {
    const wrapper = await mount()
    const row = COMPANY.rows[0]!
    const number = wrapper.findAll('button').find(button => button.text() === String(row.total))!
    await number.trigger('click')
    expect(wrapper.emitted('drill')?.at(-1)?.[0]).toMatchObject({ managerId: row.managerId, total: row.total })
  })

  // Клавиатура: сектор — это кнопка, и открываться список обязан не только мышью.
  it('сектор открывается с клавиатуры', async () => {
    const wrapper = await mount()
    await wrapper.findAll('svg path')[0]!.trigger('keydown.enter')
    expect(wrapper.emitted('drill')).toBeTruthy()
  })

  it('в подсказках секторов — менеджеры и стадии с их числами', async () => {
    const wrapper = await mount()
    const row = COMPANY.rows[0]!
    const stageId = Object.keys(row.byStage)[0]!
    const titles = wrapper.findAll('svg path title').map(node => node.text())
    expect(titles).toContain(`${row.managerName}: ${row.total}`)
    expect(titles.some(title => title.includes(': '))).toBe(true)
    // Ключи ядра — те же, что у клеток матрицы: диаграмма и таблица спрашивают одно и то же.
    expect(pairKey(COMPANY.companyId, row.managerId)).toContain(String(row.managerId))
    expect(cellKey(COMPANY.companyId, row.managerId, stageId)).toContain(stageId)
  })

  /**
   * Свёрнутый хвост менеджеров («Остальные») — сектор БЕЗ списка.
   *
   * ⚠ Он не должен быть ни кнопкой, ни точкой табуляции: «остальные менеджеры» фильтром REST не
   * выразить, а число без совпадающего списка в этом отчёте не кликабельно. Со скринридера и с
   * клавиатуры такой сектор выглядел бы сломанной кнопкой.
   */
  it('сектор без списка не кликабелен и не в табуляции', async () => {
    const wrapper = await mount()
    const dead = wrapper.findAll('svg path').filter(path => path.attributes('role') === undefined)
    expect(dead.length).toBeGreaterThan(0)
    for (const path of dead) expect(path.attributes('tabindex')).toBeUndefined()
    await dead[0]!.trigger('click')
    expect(wrapper.emitted('drill')).toBeUndefined()
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

  /**
   * ⚠ Группа без «моей компании» — такая же компания, но подписей у неё ДВЕ. В заголовке блока
   * стоит «Без моей компании»: рядом нет слов про «мою компанию», и короткое «Не указана»
   * читалось бы как «что не указана?».
   */
  it('группу без «моей компании» подписывает полным именем и объясняет, что это', async () => {
    const unset = FULL.companies.find(company => company.companyId === COMPANY_UNSET)!
    const wrapper = await mountSuspended(ManagerDistribution, {
      props: {
        report: { ...FULL, companies: [unset], total: unset.total, unlisted: unset.unlisted, managers: unset.rows.length, companyCount: 1 },
        totalStages: 6,
        scopeLabel: 'В работе'
      }
    })
    expect(wrapper.text()).toContain(`Распределение: ${COMPANY_UNSET_FULL_LABEL}`)
    expect(wrapper.text()).toContain('поле «Моя компания» у этих сделок не заполнено')
  })

  /**
   * Кольцо показывает первых, легенда — ВСЕХ, и её числа обязаны открывать список так же, как
   * числа таблицы.
   *
   * ⚠ Раньше легенда искала ссылку по номеру строки и на тринадцатом менеджере молча попадала в
   * сектор «Остальные», у которого списка нет: строки переставали быть кнопками, хотя те же
   * числа в таблице открывались.
   */
  it('числа легенды кликабельны и у менеджеров за пределами кольца', async () => {
    const rows = Array.from({ length: CHART_MANAGERS + 2 }, (_, index) => ({
      managerId: index + 1,
      managerName: `Сотрудник ${index + 1}`,
      byStage: { NEW: 1 },
      otherStages: 0,
      total: 1,
      share: 1 / (CHART_MANAGERS + 2)
    }))
    const company = { ...COMPANY, rows, total: rows.length, unlisted: 0, unlistedByStage: {} }
    const wrapper = await mountSuspended(ManagerDistribution, {
      props: {
        report: { ...REPORT, companies: [company], total: company.total, unlisted: 0, managers: rows.length },
        totalStages: 6,
        scopeLabel: 'В работе'
      }
    })
    const last = rows.at(-1)!
    const button = wrapper.findAll('button').find(node => node.attributes('title') === `Открыть список: ${last.managerName}`)
    expect(button, 'у последнего менеджера легенды нет кнопки').toBeTruthy()
    await button!.trigger('click')
    expect(wrapper.emitted('drill')?.at(-1)?.[0]).toMatchObject({ managerId: last.managerId, companyId: company.companyId })
  })

  /**
   * ⚠ «Остальные» и «Без ответственного» не красятся палитрой: слотов ровно столько же, сколько
   * менеджеров в кольце, и по кругу тринадцатый сектор встал бы рядом с первым в его же цвете.
   */
  it('служебные сектора закрашены не палитрой', async () => {
    const rows = Array.from({ length: CHART_MANAGERS + 2 }, (_, index) => ({
      managerId: index + 1,
      managerName: `Сотрудник ${index + 1}`,
      byStage: { NEW: 1 },
      otherStages: 0,
      total: 1,
      share: 0
    }))
    const company = { ...COMPANY, rows, total: rows.length + 3, unlisted: 3, unlistedByStage: { NEW: 3 } }
    const wrapper = await mountSuspended(ManagerDistribution, {
      props: {
        report: { ...REPORT, companies: [company], total: company.total, unlisted: 3, managers: rows.length },
        totalStages: 6,
        scopeLabel: 'В работе'
      }
    })
    const fills = wrapper.findAll('svg path').map(node => node.attributes('fill'))
    expect(fills).toContain('var(--chart-muted)')
    expect(fills).toContain('var(--chart-muted-strong)')
  })
})
