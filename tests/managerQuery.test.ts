import { describe, expect, it } from 'vitest'
import {
  cellCountRequests,
  cellDealFilter,
  collectTotals,
  companyNamesParams,
  countBatch,
  distinctChainBatch,
  managerDealFilter,
  managerScanFilter,
  companyCountRequests,
  companyStageCountRequests,
  pairCountRequests,
  readDistinctChain,
  stageListParams
} from '~/utils/managerQuery'
import { cellKey, companyKey, companyStageKey, pairKey, totalKey } from '~/utils/managerLoad'

/**
 * Запросы отчёта «Сделки по менеджерам». Ошибка здесь не роняет отчёт — она тихо меняет все
 * числа на экране, поэтому проверяем ровно фильтры, ключи и разбор цепочки.
 */

const PERIOD = { from: '2026-09-01', to: '2026-09-30' }
/** Период обязателен: «за всё время» убрано решением владельца от 2026-09-05. */
const DATES = { '>=DATE_CREATE': '2026-09-01', '<DATE_CREATE': '2026-10-01' }

describe('managerDealFilter', () => {
  it('направление обязательно, охват — семантикой стадии', () => {
    expect(managerDealFilter({ categoryId: 3, scope: 'in-work', period: PERIOD })).toEqual({ CATEGORY_ID: 3, STAGE_SEMANTIC_ID: 'P', ...DATES })
    expect(managerDealFilter({ categoryId: 3, scope: 'won', period: PERIOD })).toEqual({ CATEGORY_ID: 3, STAGE_SEMANTIC_ID: 'S', ...DATES })
  })

  // Направление по умолчанию — это `CATEGORY_ID = 0`, а не «фильтра нет»: без него в матрицу
  // попали бы сделки всех четырёх направлений с чужими стадиями.
  it('нулевое направление остаётся в фильтре', () => {
    expect(managerDealFilter({ categoryId: 0, scope: 'all', period: PERIOD })).toEqual({ CATEGORY_ID: 0, ...DATES })
  })

  it('период ложится на дату создания сделки, конец периода включительно', () => {
    expect(managerDealFilter({ categoryId: 0, scope: 'all', period: PERIOD })).toEqual({
      'CATEGORY_ID': 0,
      '>=DATE_CREATE': '2026-09-01',
      '<DATE_CREATE': '2026-10-01'
    })
  })

  // ⚠ Ноль — ЗНАЧЕНИЕ («Без моей компании»), а не «не задано»: на боевом портале `MYCOMPANY_ID: 0`
  // отдаёт сделки с незаполненным полем. Проверка на истинность превратила бы этот выбор во
  // «все компании», и заметить подмену на экране было бы нельзя.
  it('выбранная компания попадает в фильтр, ноль — тоже', () => {
    expect(managerDealFilter({ categoryId: 0, scope: 'all', period: PERIOD, companyId: 17 })).toEqual({ CATEGORY_ID: 0, ...DATES, MYCOMPANY_ID: 17 })
    expect(managerDealFilter({ categoryId: 0, scope: 'all', period: PERIOD, companyId: 0 })).toEqual({ CATEGORY_ID: 0, ...DATES, MYCOMPANY_ID: 0 })
  })
})

describe('managerScanFilter', () => {
  // ⚠ Перечисление компаний идёт БЕЗ фильтра компании: иначе, выбрав одну, человек получил бы
  // список из неё одной и не смог бы вернуться ко всем.
  it('компанию в фильтр не кладёт, всё остальное — как в основном', () => {
    const filters = { categoryId: 2, scope: 'in-work' as const, period: PERIOD, companyId: 17 }
    expect(managerScanFilter(filters)).toEqual({ CATEGORY_ID: 2, STAGE_SEMANTIC_ID: 'P', ...DATES })
    expect(managerDealFilter(filters)).toEqual({ CATEGORY_ID: 2, STAGE_SEMANTIC_ID: 'P', ...DATES, MYCOMPANY_ID: 17 })
  })
})

describe('stageListParams', () => {
  it('направление по умолчанию живёт под именем без суффикса', () => {
    expect(stageListParams(0)).toEqual({ filter: { ENTITY_ID: 'DEAL_STAGE' } })
    expect(stageListParams(4)).toEqual({ filter: { ENTITY_ID: 'DEAL_STAGE_4' } })
  })
})

describe('distinctChainBatch и readDistinctChain', () => {
  it('первая команда идёт от заданного значения, следующие — от ответа предыдущей', () => {
    const commands = distinctChainBatch('ASSIGNED_BY_ID', { CATEGORY_ID: 0 }, 3, 7, 'm')
    expect(Object.keys(commands)).toEqual(['m0', 'm1', 'm2'])
    expect((commands.m0!.params as { filter: Record<string, unknown> }).filter).toEqual({ 'CATEGORY_ID': 0, '>ASSIGNED_BY_ID': 7 })
    // Быстрый режим: итог портал не считает, а сортировку соблюдает — на множестве в сотни тысяч
    // сделок это разница между 0,6 с и 4,5 с на пакет (замер 2026-09-05).
    expect((commands.m0!.params as { start: number }).start).toBe(-1)
    expect((commands.m2!.params as { filter: Record<string, unknown> }).filter['>ASSIGNED_BY_ID']).toBe('$result[m1][0][ASSIGNED_BY_ID]')
  })

  it('читает значения по порядку', () => {
    const rows = { m0: [{ ASSIGNED_BY_ID: '1' }], m1: [{ ASSIGNED_BY_ID: '7' }], m2: [{ ASSIGNED_BY_ID: '8' }] }
    expect(readDistinctChain(rows, 'ASSIGNED_BY_ID', 3, 'm')).toEqual([1, 7, 8])
  })

  // ⚠ Ровно та ловушка, ради которой функция существует: когда значения кончились, портал не
  // возвращает ошибку — ссылка `$result` не разрешается, фильтр пустеет, и цепочка идёт по
  // второму кругу. Без этой проверки менеджеры дублировались бы, а счётчики пар считались бы
  // дважды (проверено на боевом портале 2026-09-05).
  it('обрывается на пустом ответе и не берёт второй круг цепочки', () => {
    const rows = {
      m0: [{ ASSIGNED_BY_ID: '1' }],
      m1: [{ ASSIGNED_BY_ID: '7' }],
      m2: [],
      m3: [{ ASSIGNED_BY_ID: '1' }],
      m4: [{ ASSIGNED_BY_ID: '7' }]
    }
    expect(readDistinctChain(rows, 'ASSIGNED_BY_ID', 5, 'm')).toEqual([1, 7])
  })

  it('значение, которое не больше предыдущего, обрывает чтение', () => {
    const rows = { m0: [{ ASSIGNED_BY_ID: '5' }], m1: [{ ASSIGNED_BY_ID: '5' }] }
    expect(readDistinctChain(rows, 'ASSIGNED_BY_ID', 2, 'm')).toEqual([5])
  })
})

describe('счётчики', () => {
  const base = { CATEGORY_ID: 0, STAGE_SEMANTIC_ID: 'P' }

  it('итог отбора и итоги компаний', () => {
    const requests = companyCountRequests([10, 0], base)
    expect(requests.map(r => r.key)).toEqual([totalKey(), companyKey(10), companyKey(0)])
    expect(requests[1]!.filter).toEqual({ ...base, MYCOMPANY_ID: 10 })
    // «Не указана» — это значение 0 в фильтре, а не отсутствие условия.
    expect(requests[2]!.filter).toEqual({ ...base, MYCOMPANY_ID: 0 })
  })

  // Итог колонки — свой вопрос порталу: в сумму клеток не попали бы сделки без ответственного,
  // и клик по итогу колонки открывал бы список длиннее числа над ним.
  it('итоги колонок спрашиваются отдельно от клеток', () => {
    const requests = companyStageCountRequests([10, 0], ['NEW'], base)
    expect(requests.map(r => r.key)).toEqual([companyStageKey(10, 'NEW'), companyStageKey(0, 'NEW')])
    expect(requests[0]!.filter).toEqual({ ...base, MYCOMPANY_ID: 10, STAGE_ID: 'NEW' })
  })

  it('пары спрашиваются по всем компаниям: менеджер бывает сразу в двух', () => {
    const requests = pairCountRequests([10, 20], [1, 2], base)
    expect(requests).toHaveLength(4)
    expect(requests[0]!.key).toBe(pairKey(10, 1))
    expect(requests[3]!.filter).toEqual({ ...base, MYCOMPANY_ID: 20, ASSIGNED_BY_ID: 2 })
  })

  it('клетки — только по непустым парам', () => {
    const requests = cellCountRequests([{ companyId: 10, managerId: 1 }], ['NEW', 'C4:LOSE'], base)
    expect(requests.map(r => r.key)).toEqual([cellKey(10, 1, 'NEW'), cellKey(10, 1, 'C4:LOSE')])
    expect(requests[1]!.filter).toEqual({ ...base, MYCOMPANY_ID: 10, ASSIGNED_BY_ID: 1, STAGE_ID: 'C4:LOSE' })
  })

  // Имя команды пакета не должно зависеть от кода стадии: коды направлений выглядят как `C4:LOSE`.
  it('имена команд — порядковые, соответствие возвращается картой', () => {
    const { commands, keyByCommand } = countBatch(cellCountRequests([{ companyId: 1, managerId: 2 }], ['C4:LOSE'], base))
    expect(Object.keys(commands)).toEqual(['n0'])
    expect(keyByCommand.n0).toBe(cellKey(1, 2, 'C4:LOSE'))
    expect(commands.n0!.method).toBe('crm.deal.list')
    // Строк не просим вовсе — нужен только `total`.
    expect((commands.n0!.params as { select: string[] }).select).toEqual(['ID'])
  })

  it('ответы пакета раскладываются по ключам ядра', () => {
    const { keyByCommand } = countBatch([{ key: totalKey(), filter: {} }, { key: companyKey(5), filter: {} }])
    expect(collectTotals({ n0: 30, n1: 12 }, keyByCommand)).toEqual({ [totalKey()]: 30, [companyKey(5)]: 12 })
  })

  // Команда осталась без ответа (портал ответил ошибкой на неё одну): ключ не появляется вовсе,
  // и ядро читает его как ноль — а не как `NaN`, который расползся бы по всей матрице.
  it('нечисловой ответ команды в счётчики не попадает', () => {
    expect(collectTotals({ n0: Number.NaN, n1: 5 }, { n0: totalKey(), n1: companyKey(5) }))
      .toEqual({ [companyKey(5)]: 5 })
  })

  it('счётчики нескольких пакетов складываются в один набор', () => {
    const into = collectTotals({ n0: 30 }, { n0: totalKey() })
    collectTotals({ n0: 12 }, { n0: companyKey(5) }, into)
    expect(into).toEqual({ [totalKey()]: 30, [companyKey(5)]: 12 })
  })
})

describe('cellDealFilter', () => {
  const base = { CATEGORY_ID: 0, STAGE_SEMANTIC_ID: 'P' }

  it('список за клеткой — тем же условием, что дало число', () => {
    expect(cellDealFilter(base, { companyId: 10, managerId: 3, stageId: 'NEW' })).toEqual({
      ...base, MYCOMPANY_ID: 10, ASSIGNED_BY_ID: 3, STAGE_ID: 'NEW'
    })
  })

  it('строка «всего» — без стадии, итог компании — без менеджера', () => {
    expect(cellDealFilter(base, { companyId: 10, managerId: 3 })).toEqual({ ...base, MYCOMPANY_ID: 10, ASSIGNED_BY_ID: 3 })
    expect(cellDealFilter(base, { companyId: 0 })).toEqual({ ...base, MYCOMPANY_ID: 0 })
  })
})

describe('companyNamesParams', () => {
  it('спрашивает только имена встреченных компаний', () => {
    expect(companyNamesParams([1, 2])).toEqual({ select: ['ID', 'TITLE'], filter: { ID: [1, 2] } })
  })
})
