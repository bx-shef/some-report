import type { ReportDataset, ReportDeal, ReportLead } from '~/types/report'

/**
 * Демонстрационный набор данных — тот самый макет, по которому согласовывали отчёт.
 *
 * Зачем он нужен отдельным модулем, а не «числами в шаблоне»: цифры на макете НЕ СХОДЯТСЯ между
 * собой (сумма выручки по источникам 490 000, а в сводке 485 000). Пока показатели набиты руками,
 * такое расхождение неизбежно и незаметно. Здесь набор задан ЛИДАМИ И СДЕЛКАМИ, а все итоги
 * считает то же ядро, что и на живых данных, — сойтись не сойтись им уже не из чего.
 *
 * ⚠ Единственное сознательное отклонение от макета: выручка «Онлайн-чата» — 50 000, а не 55 000.
 * Так сумма по источникам даёт ровно 485 000 из сводки. Обратное решение (485 000 → 490 000)
 * разошлось бы с блоком «Сводка», который на макете виден первым.
 *
 * ⚠ Это ДЕМО-данные. Живой отчёт берёт их из портала (`app/utils/b24Adapter.ts`), и попасть в
 * интерфейс мок может только явным флагом — см. `useReportData`.
 */

interface MockSourceSpec {
  id: string
  name: string
  leads: number
  junk: number
  qualified: number
  won: number
  revenue: number
}

/** Источники с макета. `qualified = leads − junk` — так на макете, потерь до сделки там нет. */
const SOURCES: MockSourceSpec[] = [
  { id: 'CALL', name: 'Входящий звонок', leads: 500, junk: 80, qualified: 420, won: 270, revenue: 220_000 },
  { id: 'EMAIL', name: 'Email', leads: 300, junk: 50, qualified: 250, won: 160, revenue: 130_000 },
  { id: 'WEB_FORM', name: 'Формы сайта', leads: 250, junk: 70, qualified: 180, won: 110, revenue: 85_000 },
  { id: 'CHAT', name: 'Онлайн-чат', leads: 200, junk: 50, qualified: 150, won: 80, revenue: 50_000 }
]

/** Причины брака с макета: код → имя и сколько лидов на неё приходится. */
const JUNK_REASONS: Array<{ id: string, name: string, count: number }> = [
  { id: 'JUNK_IRRELEVANT', name: 'Нецелевой запрос', count: 90 },
  { id: 'JUNK_DUPLICATE', name: 'Дубль обращения', count: 80 },
  { id: 'JUNK_SERVICE', name: 'Сервисное обращение', count: 50 },
  { id: 'JUNK_SPAM', name: 'Спам', count: 30 }
]

/** Причины проигрыша с макета: сколько сделок и сколько денег на каждую. */
const LOSS_REASONS: Array<{ id: string, name: string, count: number, revenue: number }> = [
  { id: 'LOSS_PRICE', name: 'Цена', count: 120, revenue: 95_000 },
  { id: 'LOSS_LEAD_TIME', name: 'Срок поставки', count: 85, revenue: 68_000 },
  { id: 'LOSS_COMPETITOR', name: 'Купил у другого поставщика', count: 70, revenue: 57_000 },
  { id: 'LOSS_NO_STOCK', name: 'Не можем поставить', count: 55, revenue: 44_000 },
  { id: 'LOSS_OTHER', name: 'Прочее', count: 50, revenue: 36_000 }
]

const PERIOD = { from: '2026-08-01', to: '2026-08-31' }

/**
 * Раздать `total` поровну на `parts` долей так, чтобы сумма совпала ТОЧНО: остаток от деления
 * кладётся в первые доли по единице. Наивное `total / parts` с округлением даёт расхождение в
 * несколько единиц — ровно тот дефект, из-за которого макет и не сходится.
 */
function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return []
  const base = Math.floor(total / parts)
  const remainder = total - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0))
}

/**
 * Время первого ответа в минутах. Большинство укладывается в час, каждый седьмой лид «зависает»
 * на пару часов.
 *
 * ⚠ Раньше здесь стояло `5 + (id % 180)`, то есть до трёх часов у каждого второго, — и блок
 * «Обработка лидов» показывал 71 % просрочки при нормативе в час. Демо-данные, которые выглядят
 * катастрофой, читаются как ошибка отчёта, а не как демонстрация.
 */
function firstResponseMinutes(id: number): number {
  return id % 7 === 0 ? 90 + (id % 60) : 5 + (id % 50)
}

/** Дата внутри августа 2026, разложенная по дням детерминированно (без случайности). */
function createdAt(index: number): string {
  const day = (index % 31) + 1
  const hour = 8 + (index % 10)
  return `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`
}

/**
 * Собрать демо-набор. Функция, а не константа: набор строится из спецификации выше, и любое
 * изменение спецификации тут же отражается во всех блоках отчёта.
 */
export function buildMockDataset(): ReportDataset {
  const leads: ReportLead[] = []
  const deals: ReportDeal[] = []

  // Очередь причин брака: каждый следующий бракованный лид забирает причину с непустой квотой.
  const junkQueue: string[] = JUNK_REASONS.flatMap(r => Array.from({ length: r.count }, () => r.id))
  // То же для причин проигрыша, вместе с суммой каждой конкретной сделки.
  const lossQueue: Array<{ id: string, amount: number }> = LOSS_REASONS.flatMap(r =>
    splitEvenly(r.revenue, r.count).map(amount => ({ id: r.id, amount }))
  )

  let leadId = 1
  let dealId = 1
  let junkCursor = 0
  let lossCursor = 0

  for (const source of SOURCES) {
    const wonAmounts = splitEvenly(source.revenue, source.won)
    const lostCount = source.qualified - source.won
    let wonMade = 0
    let lostMade = 0
    let junkMade = 0
    let qualifiedMade = 0

    for (let i = 0; i < source.leads; i++) {
      const id = leadId++
      const created = createdAt(id)
      // Каждый двенадцатый лид оставляем необработанным — иначе блок «Обработка лидов» показывал
      // бы идеальные 100 %, на которых не видно, работает ли он вообще.
      const answered = id % 12 !== 0
      const lead: ReportLead = {
        id,
        createdAt: created,
        sourceId: source.id,
        assignedById: (id % 4) + 1,
        outcome: 'in-work',
        dealIds: [],
        ...(answered
          ? { firstResponseAt: new Date(Date.parse(created) + firstResponseMinutes(id) * 60_000).toISOString() }
          : {})
      }

      if (junkMade < source.junk) {
        junkMade++
        lead.outcome = 'junk'
        lead.junkReasonId = junkQueue[junkCursor++] ?? 'JUNK_OTHER'
      } else if (qualifiedMade < source.qualified) {
        qualifiedMade++
        lead.outcome = 'converted'
        const deal: ReportDeal = wonMade < source.won
          ? {
              id: dealId,
              leadId: id,
              sourceId: source.id,
              assignedById: lead.assignedById,
              outcome: 'won',
              amount: wonAmounts[wonMade++] ?? 0
            }
          : (() => {
              const loss = lossQueue[lossCursor++]
              lostMade++
              return {
                id: dealId,
                leadId: id,
                sourceId: source.id,
                assignedById: lead.assignedById,
                outcome: 'lost' as const,
                amount: loss?.amount ?? 0,
                lossReasonId: loss?.id ?? 'LOSS_OTHER'
              }
            })()
        deals.push(deal)
        lead.dealIds = [deal.id]
        dealId++
      }

      leads.push(lead)
    }
    // Спецификация обязана сходиться: если она разъедется, демо-цифры разойдутся с макетом молча.
    if (lostMade !== lostCount) {
      throw new Error(`mockReport: источник ${source.id} — проигранных ${lostMade}, ожидалось ${lostCount}`)
    }
  }

  return {
    leads,
    deals,
    currencyId: 'BYN',
    period: PERIOD,
    dictionaries: {
      sources: Object.fromEntries(SOURCES.map(s => [s.id, s.name])),
      junkReasons: Object.fromEntries(JUNK_REASONS.map(r => [r.id, r.name])),
      lossReasons: Object.fromEntries(LOSS_REASONS.map(r => [r.id, r.name]))
    }
  }
}
