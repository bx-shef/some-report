import { describe, expect, it } from 'vitest'
import type { ReportDeal, ReportLead, ReportOptions } from '~/types/report'
import {
  UNSPECIFIED_REASON,
  aggregateLeads,
  UNSPECIFIED_SOURCE,
  buildReport,
  conversionBaseValue,
  funnelStages,
  isQualified,
  junkByReason,
  lostDeals,
  preDealLoss,
  processingMetrics,
  share,
  sourceRows,
  summaryMetrics,
  topSources
} from '~/utils/metrics'

const QUALITY: ReportOptions = { conversionBase: 'quality-leads' }
const ALL: ReportOptions = { conversionBase: 'all-leads' }

function lead(patch: Partial<ReportLead> & { id: number }): ReportLead {
  return {
    createdAt: '2026-08-01T10:00:00Z',
    sourceId: 'CALL',
    assignedById: 1,
    outcome: 'in-work',
    dealIds: [],
    ...patch
  }
}

function deal(patch: Partial<ReportDeal> & { id: number }): ReportDeal {
  return {
    sourceId: 'CALL',
    assignedById: 1,
    outcome: 'in-work',
    amount: 0,
    ...patch
  }
}

/** Строки → агрегат: все формулы ядра теперь принимают итоги, а не лиды поимённо. */
function agg(leads: ReportLead[], options: ReportOptions = QUALITY) {
  return aggregateLeads(leads, options)
}

describe('share', () => {
  it('делит как обычно', () => {
    expect(share(1, 4)).toBe(0.25)
  })

  // Пустой период — норма этого отчёта, а не крайний случай: NaN/Infinity утекли бы прямо в вёрстку.
  it.each([
    ['нулевой знаменатель', 1, 0],
    ['оба нуля', 0, 0],
    ['NaN в числителе', Number.NaN, 10],
    ['Infinity в знаменателе', 1, Number.POSITIVE_INFINITY]
  ])('%s даёт 0, а не NaN/Infinity', (_name, part, whole) => {
    expect(share(part, whole)).toBe(0)
  })
})

describe('conversionBaseValue', () => {
  it('quality-leads вычитает брак (формула ТЗ)', () => {
    expect(conversionBaseValue(1250, 250, 'quality-leads')).toBe(1000)
  })

  it('all-leads берёт весь поток (как посчитан макет)', () => {
    expect(conversionBaseValue(1250, 250, 'all-leads')).toBe(1250)
  })

  // Брака больше, чем лидов, быть не может, но данные приходят из портала — не из наших рук.
  it('не уходит в минус на противоречивых данных', () => {
    expect(conversionBaseValue(10, 20, 'quality-leads')).toBe(0)
  })
})

describe('summaryMetrics', () => {
  const leads = [
    lead({ id: 1, outcome: 'junk', junkReasonId: 'SPAM' }),
    lead({ id: 2, outcome: 'converted', dealIds: [10] }),
    lead({ id: 3, outcome: 'converted', dealIds: [11] }),
    lead({ id: 4, outcome: 'lost' })
  ]
  const deals = [
    deal({ id: 10, leadId: 2, outcome: 'won', amount: 1000 }),
    deal({ id: 11, leadId: 3, outcome: 'lost', amount: 500, lossReasonId: 'PRICE' })
  ]

  it('считает базу конверсий по ТЗ', () => {
    const s = summaryMetrics(agg(leads, QUALITY), deals, QUALITY)
    expect(s).toMatchObject({ totalLeads: 4, junk: 1, qualified: 2, wonDeals: 1, revenue: 1000 })
    expect(s.conversionBaseValue).toBe(3)
    expect(s.qualifiedShare).toBeCloseTo(2 / 3, 10)
    expect(s.wonShare).toBeCloseTo(1 / 3, 10)
  })

  it('та же выборка при базе «все лиды» даёт другие конверсии', () => {
    const s = summaryMetrics(agg(leads, ALL), deals, ALL)
    expect(s.conversionBaseValue).toBe(4)
    expect(s.qualifiedShare).toBe(0.5)
    expect(s.wonShare).toBe(0.25)
  })

  // Доля брака — единственная, что НЕ зависит от базы: брак делится на весь поток всегда.
  it('доля брака не зависит от выбранной базы', () => {
    expect(summaryMetrics(agg(leads, QUALITY), deals, QUALITY).junkShare).toBe(0.25)
    expect(summaryMetrics(agg(leads, ALL), deals, ALL).junkShare).toBe(0.25)
  })

  it('выручка складывает только успешные сделки', () => {
    expect(summaryMetrics(agg(leads, QUALITY), deals, QUALITY).revenue).toBe(1000)
  })

  it('пустая выборка не роняет расчёт', () => {
    const s = summaryMetrics(agg([], QUALITY), [], QUALITY)
    expect(s).toMatchObject({ totalLeads: 0, junk: 0, qualified: 0, revenue: 0 })
    expect(s.qualifiedShare).toBe(0)
  })
})

describe('лид, помеченный браком после создания сделки', () => {
  // ⚠ Регрессия с ревью: признаки были независимыми, и такой лид попадал сразу в оба множества —
  // из знаменателя его вычитали как брак, а в числителе оставляли как квалифицированного.
  const leads = [
    lead({ id: 1, outcome: 'junk', junkReasonId: 'SPAM', dealIds: [10] }),
    lead({ id: 2, outcome: 'converted', dealIds: [11] })
  ]
  const deals = [
    deal({ id: 10, leadId: 1, outcome: 'won', amount: 700 }),
    deal({ id: 11, leadId: 2, outcome: 'won', amount: 300 })
  ]

  it('квалифицированным не считается — приоритет у брака', () => {
    expect(isQualified(leads[0]!)).toBe(false)
    expect(summaryMetrics(agg(leads, QUALITY), deals, QUALITY).qualified).toBe(1)
  })

  it('конверсия не уезжает выше 100 %', () => {
    const summary = summaryMetrics(agg(leads, QUALITY), deals, QUALITY)
    expect(summary.conversionBaseValue).toBe(1)
    expect(summary.qualifiedShare).toBeLessThanOrEqual(1)
  })

  it('потери до сделки не вычитают его дважды', () => {
    expect(preDealLoss(agg(leads), summaryMetrics(agg(leads, QUALITY), deals, QUALITY)).count).toBe(0)
  })

  // Деньги реальны: сделка остаётся в выручке, даже если лид задним числом признали браком.
  it('его сделка остаётся в выручке', () => {
    expect(summaryMetrics(agg(leads, QUALITY), deals, QUALITY).revenue).toBe(1000)
  })
})

describe('funnelStages', () => {
  const leads = [
    lead({ id: 1, outcome: 'junk', junkReasonId: 'SPAM' }),
    lead({ id: 2, outcome: 'converted', dealIds: [10] }),
    lead({ id: 3, outcome: 'converted', dealIds: [11] })
  ]
  const deals = [
    deal({ id: 10, leadId: 2, outcome: 'won', amount: 1 }),
    deal({ id: 11, leadId: 3, outcome: 'lost', amount: 1, lossReasonId: 'PRICE' })
  ]

  // ⚠ Регрессия: доля входа воронки считалась от знаменателя конверсий, и при базе ТЗ воронка
  // начиналась со 125 % — на макете это было видно сразу, в формуле незаметно.
  it('вход воронки — всегда 100 %, при любой базе', () => {
    for (const options of [QUALITY, ALL]) {
      const stages = funnelStages(summaryMetrics(agg(leads, options), deals, options))
      expect(stages[0]!.share).toBe(1)
    }
  })

  it('следующие ступени считаются от выбранного знаменателя', () => {
    const byTz = funnelStages(summaryMetrics(agg(leads, QUALITY), deals, QUALITY))
    expect(byTz[1]!.share).toBe(1)
    expect(byTz[2]!.share).toBe(0.5)

    const byAll = funnelStages(summaryMetrics(agg(leads, ALL), deals, ALL))
    expect(byAll[1]!.share).toBeCloseTo(2 / 3, 10)
    expect(byAll[2]!.share).toBeCloseTo(1 / 3, 10)
  })

  it('пустая выборка не даёт NaN ни на одной ступени', () => {
    for (const stage of funnelStages(summaryMetrics(agg([], QUALITY), [], QUALITY))) {
      expect(Number.isFinite(stage.share)).toBe(true)
    }
  })
})

describe('junkByReason', () => {
  it('группирует, считает обе доли и сортирует по убыванию', () => {
    const leads = [
      lead({ id: 1, outcome: 'junk', junkReasonId: 'SPAM' }),
      lead({ id: 2, outcome: 'junk', junkReasonId: 'DUPLICATE' }),
      lead({ id: 3, outcome: 'junk', junkReasonId: 'DUPLICATE' }),
      lead({ id: 4, outcome: 'converted', dealIds: [1] })
    ]
    const rows = junkByReason(agg(leads))
    expect(rows.map(r => r.reasonId)).toEqual(['DUPLICATE', 'SPAM'])
    expect(rows[0]).toMatchObject({ count: 2, shareOfLeads: 0.5 })
    expect(rows[0]!.shareOfJunk).toBeCloseTo(2 / 3, 10)
  })

  // Незаполненная причина — самая частая находка на живом портале; выбросить её значит
  // показать «брак 250», а в разбивке 180 и никаких объяснений, куда делись 70.
  it('незаполненную причину сводит в отдельный код, а не выбрасывает', () => {
    const rows = junkByReason(agg([lead({ id: 1, outcome: 'junk' }), lead({ id: 2, outcome: 'junk', junkReasonId: '  ' })]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reasonId: UNSPECIFIED_REASON, count: 2, shareOfJunk: 1 })
  })
})

describe('preDealLoss', () => {
  it('считает по формуле ТЗ и отделяет «ещё в работе» от закрытых', () => {
    const leads = [
      lead({ id: 1, outcome: 'junk', junkReasonId: 'SPAM' }),
      lead({ id: 2, outcome: 'converted', dealIds: [1] }),
      lead({ id: 3, outcome: 'in-work' }),
      lead({ id: 4, outcome: 'lost' })
    ]
    const summary = summaryMetrics(agg(leads), [deal({ id: 1, leadId: 2, outcome: 'won', amount: 1 })], QUALITY)
    expect(preDealLoss(agg(leads), summary)).toMatchObject({
      count: 2,
      stillInWork: 1,
      closedWithoutDeal: 1
    })
  })
})

describe('lostDeals', () => {
  it('считает потерянную выручку и обе доли по причинам', () => {
    const leads = [lead({ id: 1, outcome: 'converted', dealIds: [1] }), lead({ id: 2, outcome: 'converted', dealIds: [2] })]
    const deals = [
      deal({ id: 1, leadId: 1, outcome: 'lost', amount: 300, lossReasonId: 'PRICE' }),
      deal({ id: 2, leadId: 2, outcome: 'lost', amount: 100, lossReasonId: 'TIME' })
    ]
    const result = lostDeals(deals, summaryMetrics(agg(leads, QUALITY), deals, QUALITY))
    expect(result).toMatchObject({ count: 2, lostRevenue: 400, shareOfQualified: 1 })
    expect(result.byReason[0]).toMatchObject({ reasonId: 'PRICE', lostRevenue: 300, shareOfLostRevenue: 0.75 })
  })

  it('портал без проигранных сделок не даёт NaN', () => {
    const result = lostDeals([], summaryMetrics(agg([], QUALITY), [], QUALITY))
    expect(result).toMatchObject({ count: 0, lostRevenue: 0, shareOfQualified: 0, byReason: [] })
  })
})

describe('sourceRows', () => {
  const leads = [
    lead({ id: 1, sourceId: 'CALL', outcome: 'junk', junkReasonId: 'SPAM' }),
    lead({ id: 2, sourceId: 'CALL', outcome: 'converted', dealIds: [1] }),
    lead({ id: 3, sourceId: 'EMAIL', outcome: 'converted', dealIds: [2] })
  ]
  const deals = [
    deal({ id: 1, leadId: 2, sourceId: 'CALL', outcome: 'won', amount: 900 }),
    deal({ id: 2, leadId: 3, sourceId: 'EMAIL', outcome: 'lost', amount: 100, lossReasonId: 'PRICE' })
  ]

  it('считает по источнику лида и сортирует по убыванию лидов', () => {
    const rows = sourceRows(agg(leads, QUALITY), deals, QUALITY)
    expect(rows.map(r => r.sourceId)).toEqual(['CALL', 'EMAIL'])
    expect(rows[0]).toMatchObject({ leads: 2, junk: 1, qualified: 1, won: 1, revenue: 900, junkShare: 0.5, crToDeal: 1 })
    expect(rows[1]).toMatchObject({ leads: 1, won: 0, revenue: 0 })
  })

  // Источник берём У ЛИДА: у сделки он может быть свой, и тогда одна продажа попала бы в две строки.
  it('источник сделки на строку источника не влияет', () => {
    const rows = sourceRows(
      agg([lead({ id: 1, sourceId: 'CALL', outcome: 'converted', dealIds: [1] })]),
      [deal({ id: 1, leadId: 1, sourceId: 'OTHER_SOURCE', outcome: 'won', amount: 500 })],
      QUALITY
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceId: 'CALL', won: 1, revenue: 500 })
  })

  // Сделка без лида-родителя (заведена руками) не имеет известного источника — выдумывать нельзя.
  it('сделки без лида в разрез источников не попадают', () => {
    const rows = sourceRows(agg(leads), [...deals, deal({ id: 3, outcome: 'won', amount: 10_000 })], QUALITY)
    expect(rows.reduce((sum, r) => sum + r.revenue, 0)).toBe(900)
  })

  it('пустой источник сводится в «другие»', () => {
    const rows = sourceRows(agg([lead({ id: 1, sourceId: '' })]), [], QUALITY)
    expect(rows[0]!.sourceId).toBe(UNSPECIFIED_SOURCE)
  })
})

describe('processingMetrics', () => {
  const leads = [
    lead({ id: 1, createdAt: '2026-08-01T10:00:00Z', firstResponseAt: '2026-08-01T10:30:00Z' }),
    lead({ id: 2, createdAt: '2026-08-01T10:00:00Z', firstResponseAt: '2026-08-01T11:30:00Z' }),
    lead({ id: 3, createdAt: '2026-08-01T10:00:00Z' })
  ]

  it('считает обработанные и среднее время первого ответа', () => {
    const p = processingMetrics(leads, QUALITY)
    expect(p).toMatchObject({ processed: 2, unprocessed: 1 })
    expect(p.avgFirstResponseMinutes).toBe(60)
    expect(p.overdue).toBeUndefined()
  })

  it('без норматива просроченные не считаются нулём — их просто нет', () => {
    expect(processingMetrics(leads, QUALITY).overdueShare).toBeUndefined()
  })

  it('с нормативом ловит и поздний ответ, и вовсе не отвеченный просроченный лид', () => {
    const p = processingMetrics(leads, {
      conversionBase: 'quality-leads',
      firstResponseSlaMinutes: 45,
      now: '2026-08-02T10:00:00Z'
    })
    // Лид 2 ответил через 90 мин (> 45), лид 3 не отвечен уже сутки. Лид 1 уложился в 30 мин.
    expect(p.overdue).toBe(2)
  })

  it('свежий лид без ответа ещё не просрочен', () => {
    const p = processingMetrics([lead({ id: 1, createdAt: '2026-08-01T10:00:00Z' })], {
      conversionBase: 'quality-leads',
      firstResponseSlaMinutes: 60,
      now: '2026-08-01T10:10:00Z'
    })
    expect(p.overdue).toBe(0)
  })
})

describe('topSources', () => {
  const rows = sourceRows(
    agg(Array.from({ length: 7 }, (_, i) => lead({ id: i + 1, sourceId: `S${i}` }))),
    [],
    QUALITY
  )

  it('берёт первые пять уже отсортированного списка', () => {
    expect(topSources(rows)).toHaveLength(5)
  })

  it.each([[0, 0], [1, 1], [3, 3], [10, 7]])('limit %s → %s строк', (limit, expected) => {
    expect(topSources(rows, limit)).toHaveLength(expected)
  })

  it('не пересчитывает, а отрезает — строки те же самые', () => {
    expect(topSources(rows, 2)).toEqual(rows.slice(0, 2))
  })
})

describe('sourceRows: расхождение со сводкой', () => {
  /**
   * ⚠ Сделки без лида-родителя в разрез источников не входят (их источник неизвестен), но в
   * сводку входят. Значит итог таблицы источников МЕНЬШЕ сводки — и это правильно, а не ошибка.
   * Отчёт объясняет расхождение отдельной строкой; тест фиксирует, что оно вообще возникает.
   */
  const leads = [lead({ id: 1, sourceId: 'CALL', outcome: 'converted', dealIds: [1] })]
  const deals = [
    deal({ id: 1, leadId: 1, sourceId: 'CALL', outcome: 'won', amount: 900 }),
    deal({ id: 2, outcome: 'won', amount: 10_000 })
  ]

  it('сводка считает сделку без лида, таблица источников — нет', () => {
    const summary = summaryMetrics(agg(leads, QUALITY), deals, QUALITY)
    const bySourceRevenue = sourceRows(agg(leads, QUALITY), deals, QUALITY).reduce((sum, r) => sum + r.revenue, 0)
    expect(summary.revenue).toBe(10_900)
    expect(bySourceRevenue).toBe(900)
    expect(summary.revenue).toBeGreaterThan(bySourceRevenue)
  })

  it('лид с двумя сделками складывает обе', () => {
    const rows = sourceRows(
      agg([lead({ id: 1, sourceId: 'CALL', outcome: 'converted', dealIds: [1, 2] })]),
      [
        deal({ id: 1, leadId: 1, outcome: 'won', amount: 100 }),
        deal({ id: 2, leadId: 1, outcome: 'won', amount: 250 })
      ],
      QUALITY
    )
    expect(rows[0]).toMatchObject({ qualified: 1, won: 2, revenue: 350 })
  })
})

describe('processingMetrics: битые и обратные даты', () => {
  // Даты приходят из портала. Отчёт обязан пережить любую строку, а не считать её нулём молча.
  it('ответ раньше создания даёт нулевую длительность, а не отрицательную', () => {
    const p = processingMetrics([
      lead({ id: 1, createdAt: '2026-08-01T10:00:00Z', firstResponseAt: '2026-08-01T09:00:00Z' })
    ], QUALITY)
    expect(p.avgFirstResponseMinutes).toBe(0)
  })

  it('битая дата не попадает в среднее и не роняет расчёт', () => {
    const p = processingMetrics([
      lead({ id: 1, createdAt: 'не-дата', firstResponseAt: '2026-08-01T10:30:00Z' }),
      lead({ id: 2, createdAt: '2026-08-01T10:00:00Z', firstResponseAt: '2026-08-01T11:00:00Z' })
    ], QUALITY)
    // Обработанными считаются оба — действие по лиду было. В среднее идёт только измеримый.
    expect(p.processed).toBe(2)
    expect(p.avgFirstResponseMinutes).toBe(60)
  })

  it('лид с битой датой не объявляется просроченным наугад', () => {
    const p = processingMetrics([lead({ id: 1, createdAt: 'мусор', firstResponseAt: 'тоже мусор' })], {
      conversionBase: 'quality-leads',
      firstResponseSlaMinutes: 30,
      now: '2026-08-02T10:00:00Z'
    })
    expect(p.overdue).toBe(0)
  })
})

describe('processingMetrics: разрез по источникам', () => {
  const leads = [
    lead({ id: 1, sourceId: 'CALL', createdAt: '2026-08-01T10:00:00Z', firstResponseAt: '2026-08-01T10:20:00Z' }),
    lead({ id: 2, sourceId: 'CALL', createdAt: '2026-08-01T10:00:00Z', firstResponseAt: '2026-08-01T10:40:00Z' }),
    lead({ id: 3, sourceId: 'EMAIL', createdAt: 'мусор', firstResponseAt: 'мусор' }),
    lead({ id: 4, sourceId: 'WEB' })
  ]

  it('группирует обработанные и сортирует по их количеству', () => {
    const rows = processingMetrics(leads, QUALITY).bySource
    expect(rows.map(r => r.sourceId)).toEqual(['CALL', 'EMAIL'])
    expect(rows[0]).toMatchObject({ processed: 2, avgFirstResponseMinutes: 30 })
  })

  // Источник, где длительность измерить не удалось, остаётся в списке — но без среднего.
  it('источник без измеримых длительностей даёт undefined, а не ноль', () => {
    const rows = processingMetrics(leads, QUALITY).bySource
    expect(rows[1]).toMatchObject({ sourceId: 'EMAIL', processed: 1 })
    expect(rows[1]!.avgFirstResponseMinutes).toBeUndefined()
  })

  it('необработанные лиды в разрез не попадают', () => {
    expect(processingMetrics(leads, QUALITY).bySource.map(r => r.sourceId)).not.toContain('WEB')
  })
})

describe('buildReport', () => {
  it('собирает все блоки за один проход', () => {
    const report = buildReport(
      [lead({ id: 1, outcome: 'converted', dealIds: [1] })],
      [deal({ id: 1, leadId: 1, outcome: 'won', amount: 100 })],
      QUALITY
    )
    expect(Object.keys(report).sort()).toEqual(
      ['bySource', 'funnel', 'junkByReason', 'lostDeals', 'preDealLoss', 'processing', 'summary', 'topSources']
    )
    expect(report.funnel.map(s => s.key)).toEqual(['leads', 'qualified', 'won'])
  })
})

describe('aggregateLeads', () => {
  // ⚠ Главный тест режима счётчиков. Живой портал приносит лиды ИТОГАМИ, демо-набор — строками;
  // если два пути дают разные числа на одних данных, отчёт врёт в одном из режимов, и заметить
  // это можно только сверкой с CRM вручную.
  it('агрегат из строк даёт тот же отчёт, что и строки', () => {
    const leads = [
      lead({ id: 1, outcome: 'junk', junkReasonId: 'SPAM', sourceId: 'CALL' }),
      lead({ id: 2, outcome: 'converted', dealIds: [10], sourceId: 'CALL' }),
      lead({ id: 3, outcome: 'in-work', sourceId: 'WEB' }),
      lead({ id: 4, outcome: 'lost', sourceId: '' })
    ]
    const deals = [deal({ id: 10, leadId: 2, outcome: 'won', amount: 500, sourceId: 'CALL' })]
    const byRows = buildReport(leads, deals, ALL)
    const agg = aggregateLeads(leads, ALL)
    expect(agg).toMatchObject({ total: 4, junk: 1, qualified: 1, inWork: 1, closedWithoutDeal: 1 })
    expect(agg.junkByReason).toEqual({ SPAM: 1 })
    expect(agg.bySource.CALL).toEqual({ leads: 2, junk: 1, qualified: 1 })
    expect(agg.bySource[UNSPECIFIED_SOURCE]).toEqual({ leads: 1, junk: 0, qualified: 0 })
    expect(byRows.summary).toMatchObject({ totalLeads: 4, junk: 1, qualified: 1, wonDeals: 1, revenue: 500 })
    expect(byRows.bySource.find(r => r.sourceId === 'CALL')).toMatchObject({ won: 1, revenue: 500 })
  })

  // Счётчики не знают лидов поимённо — источник сделки берётся у самой сделки. При конвертации
  // портал копирует источник из лида, так что для сделки ИЗ ЛИДА это тот же источник.
  it('без карты лидов источник сделки берётся у сделки', () => {
    const agg = aggregateLeads([lead({ id: 2, outcome: 'converted', dealIds: [10], sourceId: 'CALL' })], ALL)
    delete agg.leadSourceById
    const rows = sourceRows(agg, [deal({ id: 10, leadId: 2, outcome: 'won', amount: 7, sourceId: 'CALL' })], ALL)
    expect(rows.find(r => r.sourceId === 'CALL')).toMatchObject({ won: 1, revenue: 7 })
  })

  // Сделка, чей лид известен по карте, но в выборке отсутствует, в разрез не входит: иначе выручка
  // легла бы на источник, которого в таблице лидов нет, и итоги разошлись бы со сводкой.
  it('с картой лидов сделка чужого лида в разрез не входит', () => {
    const agg = aggregateLeads([lead({ id: 2, outcome: 'converted', dealIds: [10], sourceId: 'CALL' })], ALL)
    const rows = sourceRows(agg, [deal({ id: 11, leadId: 99, outcome: 'won', amount: 7, sourceId: 'WEB' })], ALL)
    expect(rows.find(r => r.sourceId === 'WEB')).toBeUndefined()
  })
})
