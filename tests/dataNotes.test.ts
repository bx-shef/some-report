import { describe, expect, it } from 'vitest'
import type { ManagerLoadReport } from '~/types/managers'
import type { AdapterWarnings } from '~/utils/b24Adapter'
import { leadsDataNotes, managerDataNotes } from '~/utils/dataNotes'

/** Всё в нуле: отчёт молчит. Каждый тест поднимает ровно одно поле. */
const quiet: AdapterWarnings = {
  unconvertedDeals: 0,
  foreignCurrencyDeals: 0,
  dealsWithoutLead: 0,
  mergedLossReasons: 0,
  duplicateIds: 0,
  wonWithoutAmount: 0
}

describe('оговорки к данным отчёта по лидам', () => {
  it('до выборки оговорок нет', () => {
    expect(leadsDataNotes(undefined)).toEqual([])
  })

  it('всё в порядке — молчит, а не говорит «ошибок 0»', () => {
    expect(leadsDataNotes(quiet)).toEqual([])
  })

  /**
   * ⚠ Главный тест этого файла. Обе оговорки про валюту, но следствия у них РАЗНЫЕ: «нет в
   * справочнике» — выручка испорчена, «не в базовой» — выручка верна, испорчен ввод. Слить их в
   * одну строку значит либо зря пугать, либо промолчать о том, что на боевом портале 162
   * успешных сделки не в BYN сложены в выручку как есть (замер 2026-09-07, `docs/PORTAL.md`).
   */
  it('две оговорки про валюту — разные строки и разные числа', () => {
    const notes = leadsDataNotes({ ...quiet, unconvertedDeals: 403, foreignCurrencyDeals: 7 })
    expect(notes).toHaveLength(2)
    const [broken, foreign] = notes as [string, string]
    expect(broken).toContain('которой нет в справочнике портала')
    expect(broken).toContain('403')
    expect(broken).toContain('КАК ЕСТЬ')
    expect(foreign).toContain('не в базовой валюте')
    expect(foreign).toContain('7')
    expect(foreign).toContain('приведены курсом')
    // И ни одна не молчит о том, что делать: число без действия читается как техническая помеха.
    expect(broken).toContain('Проверьте их в CRM')
    expect(foreign).toContain('Проверьте их в CRM')
  })

  /**
   * ⛔ Счётчик считает сделки ЛЮБОГО исхода, а выручку делают только успешные: на боевом портале
   * это 403 против 162. Обещание «их суммы вошли в выручку» отправило бы человека искать в CRM
   * расхождение в два с половиной раза больше настоящего — и он бы его не нашёл.
   */
  it('оговорка НЕ обещает, что все посчитанные сделки вошли в выручку', () => {
    const [broken, foreign] = leadsDataNotes({ ...quiet, unconvertedDeals: 403, foreignCurrencyDeals: 7 }) as [string, string]
    expect(broken).not.toContain('вошли в выручку')
    expect(foreign).not.toContain('вошли в выручку')
  })

  /**
   * ⚠ Число печатается ru-RU, как и всюду в отчёте. «4997» рядом с «4 997» из блока 7 под одной
   * и той же цифрой читается как два разных числа.
   */
  it('большие числа печатает с разрядами, а не сырой интерполяцией', () => {
    const [note] = leadsDataNotes({ ...quiet, unconvertedDeals: 4997 }) as [string]
    expect(note).toContain('4\u00a0997')
    expect(note).not.toContain('4997')
  })

  it('валюта без курса без чужих валют — одна строка со СВОИМ числом', () => {
    const notes = leadsDataNotes({ ...quiet, unconvertedDeals: 403 })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('403')
    expect(notes[0]).not.toContain('приведены курсом')
  })

  it('чужая валюта с курсом без сломанных — одна строка со СВОИМ числом', () => {
    const notes = leadsDataNotes({ ...quiet, foreignCurrencyDeals: 7 })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('7')
    expect(notes[0]).not.toContain('справочнике портала')
  })

  /**
   * ⚠ Проверяем ПОСТРОЧНО, а не склейкой через `join`. Склейка ловит только «число где-то есть»:
   * «3» находится внутри «340» из чужой строки, и перестановка двух счётчиков местами оставила
   * бы тест зелёным, а отчёт назвал бы число не своей причиной. Ровно этот класс дефекта проект
   * ловит поячеечно и в таблицах.
   */
  it('каждая оговорка называет СВОЁ число, а не чужое', () => {
    const notes = leadsDataNotes({
      ...quiet,
      dealsWithoutLead: 340,
      duplicateIds: 3,
      wonWithoutAmount: 88,
      mergedLossReasons: 6
    })
    expect(notes).toHaveLength(4)
    expect(notes[0]).toContain('Сделок без связи с лидом среди выбранных строками: 340')
    expect(notes[1]).toContain('Повторов по идентификатору отброшено: 3')
    expect(notes[2]).toContain('Успешных сделок из лидов с нулевой суммой: 88')
    expect(notes[3]).toContain('стадий свёрнуто 6')
  })

  /**
   * ⛔ Стеречь надо и ОТСУТСТВИЕ мёртвого текста. Три оговорки («лид вне периода», «успех без
   * сделки», «время первого ответа не выбиралось») ушли вместе с цельным разбором строками:
   * счётчики не видят связи лид → сделка поимённо, и выставить их живой выборке было нечем —
   * они молча печатались бы никогда. Вернуть их можно только вместе с тем, кто их считает.
   */
  it('оговорок, которые живая выборка выставить не может, здесь нет', () => {
    const everything = leadsDataNotes({
      unconvertedDeals: 1, foreignCurrencyDeals: 1, dealsWithoutLead: 1,
      mergedLossReasons: 1, duplicateIds: 1, wonWithoutAmount: 1
    }).join(' ')
    expect(everything).not.toContain('вне периода')
    expect(everything).not.toContain('у которых нет сделки')
    expect(everything).not.toContain('Время первого ответа')
  })
})

describe('оговорки к матрице отчёта «Сделки по менеджерам»', () => {
  /** Всё сошлось: остатков нет, ничего не усечено — отчёт молчит. */
  const tidy: ManagerLoadReport = {
    companies: [], stages: [], hiddenStages: 0, byStage: {}, otherStages: 0,
    unlisted: 0, total: 100, managers: 3, companyCount: 1
  }
  const whole = { managers: false, companies: false }

  it('когда всё сошлось — молчит, а не говорит «остатков 0»', () => {
    expect(managerDataNotes(tidy, whole)).toEqual([])
  })

  /**
   * ⚠ Остаток обязан быть НАЗВАН. Итог компании — отдельный счётчик портала, а не сумма строк:
   * «в таблице 25, а всего 30» без объяснения читается как потерянные отчётом сделки.
   */
  it('сделки вне строк называет числом и единственной их причиной', () => {
    const [note] = managerDataNotes({ ...tidy, unlisted: 1234 }, whole) as [string]
    expect(note).toContain('Сделок вне строк таблицы: 1\u00a0234')
    expect(note).toContain('не попал в перечисление')
  })

  it('сделки на снятых стадиях — своя строка со своим числом', () => {
    const [note] = managerDataNotes({ ...tidy, otherStages: 7 }, whole) as [string]
    expect(note).toContain('которых нет в справочнике направления: 7')
  })

  it('скрытые пустые стадии — своя строка со своим числом', () => {
    const [note] = managerDataNotes({ ...tidy, hiddenStages: 5 }, whole) as [string]
    expect(note).toContain('Пустых стадий скрыто: 5')
  })

  /**
   * ⛔ Причины усечения РАЗНЫЕ, и подсказка человеку разная: в одном случае не поместились
   * сотрудники (сделки ушли в остаток и их видно), в другом — «мои компании» (их не видно вовсе,
   * даже фильтром). Общий флаг назвал бы неверную причину, а по ней и неверное действие.
   */
  it('усечение менеджеров и усечение компаний — разные строки', () => {
    const byManagers = managerDataNotes(tidy, { managers: true, companies: false })
    expect(byManagers).toHaveLength(1)
    expect(byManagers[0]).toContain('Сотрудников в этом направлении больше')
    expect(byManagers[0]).not.toContain('Моих компаний')

    const byCompanies = managerDataNotes(tidy, { managers: false, companies: true })
    expect(byCompanies).toHaveLength(1)
    expect(byCompanies[0]).toContain('«Моих компаний» у сделок больше')
    expect(byCompanies[0]).toContain('открыть их нечем')
  })

  it('несколько бед сразу — каждая своей строкой и в порядке показа', () => {
    const notes = managerDataNotes(
      { ...tidy, unlisted: 5, otherStages: 3, hiddenStages: 2 },
      { managers: true, companies: true }
    )
    expect(notes).toHaveLength(5)
    expect(notes[0]).toContain('вне строк таблицы: 5')
    expect(notes[1]).toContain('справочнике направления: 3')
    expect(notes[2]).toContain('Сотрудников в этом направлении')
    expect(notes[3]).toContain('«Моих компаний»')
    expect(notes[4]).toContain('Пустых стадий скрыто: 2')
  })
})
