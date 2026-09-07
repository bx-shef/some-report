import { describe, expect, it } from 'vitest'
import type { AdapterWarnings } from '~/utils/b24Adapter'
import { leadsDataNotes } from '~/utils/dataNotes'

/** Всё в нуле: отчёт молчит. Каждый тест поднимает ровно одно поле. */
const quiet: AdapterWarnings = {
  unconvertedDeals: 0,
  foreignCurrencyDeals: 0,
  wonStageWithoutDeal: 0,
  dealsWithoutLead: 0,
  mergedLossReasons: 0,
  dealsWithMissingLead: 0,
  duplicateIds: 0,
  firstResponseNotFetched: false,
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
      dealsWithMissingLead: 12,
      wonStageWithoutDeal: 5,
      duplicateIds: 3,
      wonWithoutAmount: 88,
      mergedLossReasons: 6
    })
    expect(notes).toHaveLength(6)
    expect(notes[0]).toContain('Сделок без связи с лидом среди выбранных строками: 340')
    expect(notes[1]).toContain('Сделок со ссылкой на лид вне периода: 12')
    expect(notes[2]).toContain('Лидов на стадии «успех», у которых нет сделки: 5')
    expect(notes[3]).toContain('Повторов по идентификатору отброшено: 3')
    expect(notes[4]).toContain('Успешных сделок из лидов с нулевой суммой: 88')
    expect(notes[5]).toContain('стадий свёрнуто 6')
  })

  /**
   * ⚠ Это про «обработано 0 %», а не про число: без оговорки пустой блок читается как факт о
   * работе отдела продаж, хотя это факт о том, что данных не спрашивали.
   */
  it('невыбранное время первого ответа объясняется словами', () => {
    const notes = leadsDataNotes({ ...quiet, firstResponseNotFetched: true })
    expect(notes).toEqual(['Время первого ответа не выбиралось — блок «Обработка лидов» считать не по чему.'])
  })
})
