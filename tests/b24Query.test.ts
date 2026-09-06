import { describe, expect, it } from 'vitest'
import {
  DEAL_SELECT,
  LEAD_SELECT,
  dealListParams,
  dictionaryBatch,
  latestLeadParams,
  leadListParams,
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
