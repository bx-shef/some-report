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
    expect(broken).toContain('проверить в CRM')
    expect(foreign).toContain('проверить в CRM')
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

  it('каждая оговорка называет своё число', () => {
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
    expect(notes.join(' ')).toContain('340')
    expect(notes.join(' ')).toContain('12')
    expect(notes.join(' ')).toContain('5')
    expect(notes.join(' ')).toContain('3')
    expect(notes.join(' ')).toContain('88')
    expect(notes.join(' ')).toContain('6')
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
