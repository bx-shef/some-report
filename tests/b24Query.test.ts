import { describe, expect, it } from 'vitest'
import {
  DEAL_SELECT,
  LEAD_SELECT,
  dealListParams,
  dictionaryBatch,
  latestLeadParams,
  leadListParams,
  dedupeById,
  listPageCommands,
  listPageOfKey,
  nextDay,
  periodFilter
} from '~/utils/b24Query'

describe('поля выборки', () => {
  // Каждое поле здесь нужно ядру. Пропавшее не даёт ни ошибки, ни пустого экрана — отчёт просто
  // считает не то и выглядит при этом правдоподобно.
  it('у лида спрашиваем семантику стадии, источник и дату', () => {
    expect(LEAD_SELECT).toContain('STATUS_SEMANTIC_ID')
    expect(LEAD_SELECT).toContain('SOURCE_ID')
    expect(LEAD_SELECT).toContain('DATE_CREATE')
  })

  // Без LEAD_ID не собирается воронка — это та самая связь, которой в портале пока нет.
  it('у сделки спрашиваем связь с лидом, сумму и валюту', () => {
    expect(DEAL_SELECT).toContain('LEAD_ID')
    expect(DEAL_SELECT).toContain('OPPORTUNITY')
    expect(DEAL_SELECT).toContain('CURRENCY_ID')
    expect(DEAL_SELECT).toContain('STAGE_SEMANTIC_ID')
  })
})

describe('nextDay', () => {
  it('даёт следующий день', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01')
  })

  it('переходит через год', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })

  it('знает про високосный год', () => {
    expect(nextDay('2028-02-28')).toBe('2028-02-29')
  })

  it('непонятную строку отдаёт как есть, а не превращает фильтр в мусор', () => {
    expect(nextDay('никогда')).toBe('никогда')
  })
})

describe('periodFilter', () => {
  // ⚠ Главный тест файла. Битрикс24 сравнивает DATE_CREATE как дату-ВРЕМЯ: `<=` с последним днём
  // означает «до его полуночи» и молча выбрасывает весь последний день периода. Отчёт при этом
  // не ломается — просто недосчитывает лиды за последние сутки.
  it('верхняя граница строгая и на следующий день — иначе теряется последний день', () => {
    const filter = periodFilter({ from: '2026-09-01', to: '2026-09-30' })
    expect(filter['>=DATE_CREATE']).toBe('2026-09-01')
    expect(filter['<DATE_CREATE']).toBe('2026-10-01')
    expect(filter['<=DATE_CREATE']).toBeUndefined()
  })

  it('умеет фильтровать по другому полю', () => {
    expect(periodFilter({ from: '2026-01-01', to: '2026-01-31' }, 'CLOSEDATE'))
      .toEqual({ '>=CLOSEDATE': '2026-01-01', '<CLOSEDATE': '2026-02-01' })
  })
})

describe('параметры списков', () => {
  const period = { from: '2026-09-01', to: '2026-09-30' }

  it('лиды: поля и период', () => {
    const params = leadListParams(period)
    expect(params.select).toEqual([...LEAD_SELECT])
    expect(params.filter['<DATE_CREATE']).toBe('2026-10-01')
  })

  it('сделки: поля и период', () => {
    const params = dealListParams(period)
    expect(params.select).toEqual([...DEAL_SELECT])
    expect(params.filter['>=DATE_CREATE']).toBe('2026-09-01')
  })

  // `order` в постраничной выборке недоступен — она сама сортирует по ID. Для «последнего лида»
  // нужен обычный вызов, и сортировка обязана быть по убыванию даты.
  it('последний лид: сортировка по дате вниз', () => {
    expect(latestLeadParams().order).toEqual({ DATE_CREATE: 'DESC' })
  })
})

describe('dictionaryBatch', () => {
  // Имена команд обязаны совпадать с полями AdapterInput: иначе разбор ответа превращается в
  // перекладывание по индексам, а ошибка в нём даёт отчёт без названий стадий.
  it('спрашивает четыре справочника под именами полей адаптера', () => {
    expect(Object.keys(dictionaryBatch()).sort())
      .toEqual(['currencies', 'dealStages', 'leadStatuses', 'sources'])
  })

  it('каждый справочник просит свой ENTITY_ID', () => {
    const batch = dictionaryBatch()
    expect(batch.sources.params.filter.ENTITY_ID).toBe('SOURCE')
    expect(batch.leadStatuses.params.filter.ENTITY_ID).toBe('STATUS')
    expect(batch.dealStages.params.filter.ENTITY_ID).toBe('DEAL_STAGE')
  })
})

describe('страницы смещением', () => {
  const PARAMS = { select: ['ID', 'OPPORTUNITY'], filter: { '>=CLOSEDATE': '2026-08-01', 'LEAD_ID': [0] } }

  it('раскладывает страницы по смещению от заданной', () => {
    const commands = listPageCommands('crm.deal.list', PARAMS, 3, 4)
    expect(Object.keys(commands)).toEqual(['p3', 'p4', 'p5', 'p6'])
    expect(commands.p3?.params.start).toBe(150)
    expect(commands.p6?.params.start).toBe(300)
    expect(commands.p3?.method).toBe('crm.deal.list')
  })

  it('несёт условие отбора в каждую страницу', () => {
    const commands = listPageCommands('crm.deal.list', PARAMS, 0, 2)
    for (const command of Object.values(commands)) {
      expect(command.params.filter).toEqual(PARAMS.filter)
      expect(command.params.select).toEqual(PARAMS.select)
    }
  })

  /**
   * ⛔ Сторож всего приёма. Замер боевого портала 2026-09-07: `crm.deal.list` со смещением
   * стоит 32 мс на страницу БЕЗ `order` и 547 мс С НИМ — то есть добавленная сюда сортировка
   * делает выборку МЕДЛЕННЕЕ курсора (271 мс), ради ухода от которого всё и затевалось.
   *
   * Заметить это по числам отчёта нельзя вовсе: данные те же, просто минута вместо шести секунд.
   */
  it('НЕ заказывает сортировку — в ней вся цена', () => {
    const commands = listPageCommands('crm.deal.list', PARAMS, 0, 3)
    for (const command of Object.values(commands)) {
      expect(command.params).not.toHaveProperty('order')
      expect(command.params).not.toHaveProperty('sort')
      // Курсор тоже не должен просочиться: он и есть то, что требует сортировки.
      expect(JSON.stringify(command.params.filter)).not.toContain('>ID')
    }
  })

  it('номер страницы читается из ключа, а не из порядка ответа', () => {
    expect(listPageOfKey('p0')).toBe(0)
    expect(listPageOfKey('p10')).toBe(10)
    // ⚠ Сортировка ключей строкой поставила бы `p10` перед `p2` — потому и разбираем число.
    expect(listPageOfKey('p10')).toBeGreaterThan(listPageOfKey('p2'))
  })

  it('чужой ключ не притворяется страницей', () => {
    for (const key of ['total', 'sources', 'p', 'p-1', 'px', 'c3', '']) {
      expect(listPageOfKey(key)).toBe(-1)
    }
  })
})

describe('сведение строк многостраничной выборки', () => {
  /**
   * ⚠ Дубль возможен ТОЛЬКО при чтении смещением: курсор просит строки строго после предыдущей
   * страницы, а смещение — «с 50-й по 99-ю», и вставка между страницами сдвигает окно. У
   * заказчика 10 тысяч сделок в месяц, то есть окно сдвигается регулярно.
   */
  it('одна и та же запись на двух страницах остаётся одной', () => {
    const rows = [{ ID: '1', V: 'a' }, { ID: '2', V: 'b' }, { ID: '1', V: 'a' }]
    expect(dedupeById(rows)).toHaveLength(2)
    expect(dedupeById(rows).map(r => r.ID)).toEqual(['1', '2'])
  })

  it('числовой и строковый идентификатор — одна запись, а не две', () => {
    expect(dedupeById([{ ID: 7 }, { ID: '7' }])).toHaveLength(1)
  })

  /**
   * ⚠ Ноль проверяется отдельно, потому что в этом проекте ноль уже был ЗНАЧЕНИЕМ, а не пустотой
   * (`MYCOMPANY_ID: 0` — «поле пусто», а не «фильтра нет»). Проверка на фолсовость вместо
   * `undefined`/`null` объявила бы запись с `ID: 0` безымянной, и повторы перестали бы сводиться.
   */
  it('идентификатор 0 — это значение, а не отсутствие', () => {
    expect(dedupeById([{ ID: 0 }, { ID: 0 }])).toHaveLength(1)
    expect(dedupeById([{ ID: 0 }, { ID: '0' }])).toHaveLength(1)
    // И при этом ноль не путается с «безымянной» строкой.
    expect(dedupeById([{ ID: 0 }, { ID: undefined }])).toHaveLength(2)
  })

  /**
   * ⚠ Строку без `ID` свести не с чем. Выбросить её значило бы потерять записи МОЛЧА — а такой
   * потери на экране не видно: просто число меньше.
   */
  it('строки без идентификатора не схлопываются в одну', () => {
    expect(dedupeById([{ V: 'a' }, { V: 'b' }, { ID: '', V: 'c' }])).toHaveLength(3)
    expect(dedupeById([{ ID: undefined }, { ID: undefined }])).toHaveLength(2)
  })

  it('порядок строк не переставляет', () => {
    expect(dedupeById([{ ID: '3' }, { ID: '1' }, { ID: '2' }]).map(r => r.ID)).toEqual(['3', '1', '2'])
  })

  it('пустая выборка — пустой ответ, а не падение', () => {
    expect(dedupeById([])).toEqual([])
  })
})
