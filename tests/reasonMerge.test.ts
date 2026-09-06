import { describe, expect, it } from 'vitest'
import { mergeReasons, normalizeReasonName } from '~/utils/reasonMerge'

/**
 * Все примеры — с боевого портала заказчика (замер 2026-09-04, docs/PORTAL.md). Синтетические
 * случаи здесь бесполезны: дефект был не в логике, а в том, КАК люди пишут названия стадий.
 */
describe('normalizeReasonName', () => {
  it('регистр не различает', () => {
    expect(normalizeReasonName('Отказ - Дорого')).toBe(normalizeReasonName('Отказ - дорого'))
  })

  // Живой случай: `Отказ -Нет нужного количества` в одном направлении и `Отказ - Нет …` в другом.
  it('пробелы вокруг дефиса не значат ничего', () => {
    expect(normalizeReasonName('Отказ -Нет нужного количества на складе'))
      .toBe(normalizeReasonName('Отказ - Нет нужного количества на складе'))
  })

  // Живой случай: направление «Интернет-магазин» написано через тире.
  it('тире и дефис — одно и то же', () => {
    expect(normalizeReasonName('Отказ – Нет на складе')).toBe(normalizeReasonName('Отказ - Нет на складе'))
    expect(normalizeReasonName('Отказ — Дорого')).toBe(normalizeReasonName('Отказ - дорого'))
  })

  it('лишние пробелы схлопывает', () => {
    expect(normalizeReasonName('  Отказ  -  Тендер/биржа ')).toBe(normalizeReasonName('Отказ - тендер/биржа'))
  })

  it('пробелы вокруг косой черты и точка в конце не значат ничего', () => {
    expect(normalizeReasonName('Отказ - Тендер / биржа')).toBe(normalizeReasonName('Отказ - Тендер/биржа'))
    expect(normalizeReasonName('Отказ - Дорого.')).toBe(normalizeReasonName('Отказ - Дорого'))
  })

  it('ё и е не различает', () => {
    expect(normalizeReasonName('Ещё думает')).toBe(normalizeReasonName('Еще думает'))
  })

  /**
   * ⚠ ПРИНЯТЫЙ РИСК, зафиксированный тестом. Правила «регистр не важен», «ё = е» и «пробелы у
   * дефиса не важны» способны склеить и РАЗНЫЕ по смыслу названия — три пары ниже склеиваются.
   * На живых данных заказчика таких пар нет (все расхождения — форматирование одной причины), и
   * цена ошибки тут — одна лишняя строка в таблице против ложного объединения. Если такая пара
   * появится, менять надо правило, а не тест: он здесь, чтобы смена правила была осознанной.
   */
  it('склеивает пары, которые формально совпадают, — это известная кромка', () => {
    expect(normalizeReasonName('Отказ - Всё бракованное')).toBe(normalizeReasonName('Отказ - Все бракованное'))
    expect(normalizeReasonName('СВ - брак')).toBe(normalizeReasonName('св - брак'))
    expect(normalizeReasonName('Скидка -10%')).toBe(normalizeReasonName('Скидка - 10%'))
  })

  // ⚠ Главная проверка на ложное срабатывание: разные причины НЕ должны склеиваться.
  it('разные причины остаются разными', () => {
    expect(normalizeReasonName('Отказ - дорого')).not.toBe(normalizeReasonName('Отказ - дорого (удалить)'))
    expect(normalizeReasonName('Отказ - Нет на складе, товар складской'))
      .not.toBe(normalizeReasonName('Отказ - Не складской ассортимент'))
  })
})

describe('mergeReasons', () => {
  // Шесть стадий «дорого» боевого портала, как они есть.
  const live = [
    { STATUS_ID: 'LOSE', NAME: 'Отказ - Дорого', ENTITY_ID: 'DEAL_STAGE' },
    { STATUS_ID: '10', NAME: 'Отказ - дорого (удалить)', ENTITY_ID: 'DEAL_STAGE' },
    { STATUS_ID: 'C1:LOSE', NAME: 'Отказ - дорого', ENTITY_ID: 'DEAL_STAGE_1' },
    { STATUS_ID: 'C3:LOSE', NAME: 'Отказ - дорого', ENTITY_ID: 'DEAL_STAGE_3' },
    { STATUS_ID: 'C3:UC_CVXNKM', NAME: 'Отказ - дорого', ENTITY_ID: 'DEAL_STAGE_3' },
    { STATUS_ID: 'C4:LOSE', NAME: 'Отказ - Дорого', ENTITY_ID: 'DEAL_STAGE_4' },
    { STATUS_ID: '2', NAME: 'Отказ -Нет нужного количества на складе', ENTITY_ID: 'DEAL_STAGE' },
    { STATUS_ID: 'C4:APOLOGY', NAME: 'Отказ – Нет нужного количества на складе', ENTITY_ID: 'DEAL_STAGE_4' }
  ]

  it('пять кодов «дорого» из четырёх направлений — одна причина', () => {
    const merged = mergeReasons(live)
    const expensive = merged.reasons.find(r => r.codes.includes('LOSE'))!
    expect(expensive.codes).toEqual(['LOSE', 'C1:LOSE', 'C3:LOSE', 'C3:UC_CVXNKM', 'C4:LOSE'])
  })

  // Стадия помечена к удалению, но на ней живут сделки — это факт о гигиене CRM, его надо видеть.
  it('«(удалить)» остаётся отдельной строкой', () => {
    const merged = mergeReasons(live)
    expect(merged.keyByCode['10']).not.toBe(merged.keyByCode.LOSE)
    expect(merged.names[merged.keyByCode['10']!]).toBe('Отказ - дорого (удалить)')
  })

  it('дефис без пробела и тире сводятся с обычным написанием', () => {
    const merged = mergeReasons(live)
    expect(merged.keyByCode['2']).toBe(merged.keyByCode['C4:APOLOGY'])
  })

  // Первым идёт справочник направления по умолчанию — при прочих равных печатаем его написание.
  it('название для печати — первое встреченное, если все написаны одинаково аккуратно', () => {
    const merged = mergeReasons(live)
    expect(merged.names[merged.keyByCode.LOSE!]).toBe('Отказ - Дорого')
  })

  // Живой случай: в направлении по умолчанию «Отказ -Не складской ассортимент» (без пробела),
  // в остальных — с пробелом. Печатать первое значило бы показать то, что читается как наша опечатка.
  it('предпочитает написание с дефисом в пробелах', () => {
    const merged = mergeReasons([
      { STATUS_ID: '4', NAME: 'Отказ -Не складской ассортимент', ENTITY_ID: 'DEAL_STAGE' },
      { STATUS_ID: 'C4:4', NAME: 'Отказ - не складской ассортимент', ENTITY_ID: 'DEAL_STAGE_4' }
    ])
    expect(merged.names[merged.keyByCode['4']!]).toBe('Отказ - не складской ассортимент')
    // И ключ у обоих один — сведение от выбора написания не зависит.
    expect(merged.keyByCode['4']).toBe(merged.keyByCode['C4:4'])
  })

  // Живая пара из PORTAL.md: дефис без пробела против ТИРЕ в пробелах. Проверка по одному
  // дефису тире не видела, и аккуратное написание не побеждало никогда.
  it('тире в пробелах — тоже аккуратное написание', () => {
    const merged = mergeReasons([
      { STATUS_ID: '2', NAME: 'Отказ -Нет нужного количества на складе', ENTITY_ID: 'DEAL_STAGE' },
      { STATUS_ID: 'C4:APOLOGY', NAME: 'Отказ – Нет нужного количества на складе', ENTITY_ID: 'DEAL_STAGE_4' }
    ])
    expect(merged.names[merged.keyByCode['2']!]).toBe('Отказ – Нет нужного количества на складе')
  })

  /**
   * ⚠ При НЕСКОЛЬКИХ одинаково аккуратных написаниях печатается первое встреченное — то есть
   * из направления по умолчанию, которое `dealStageBatch` ставит первым. Это осознанный
   * тай-брейк, а не случайность: направление по умолчанию — каноничное. Тест фиксирует его,
   * чтобы смена порядка выборки стадий не поменяла подпись строки незаметно. Ключ при этом от
   * порядка не зависит вовсе.
   */
  it('при равной аккуратности печатается написание направления по умолчанию', () => {
    const rotated = [...live.slice(2), ...live.slice(0, 2)]
    const direct = mergeReasons(live)
    const shifted = mergeReasons(rotated)
    expect(shifted.keyByCode.LOSE).toBe(direct.keyByCode.LOSE)
    expect(direct.names[direct.keyByCode.LOSE!]).toBe('Отказ - Дорого')
    // Первым в перестановке идёт C1:LOSE со строчной буквой — его написание и побеждает.
    expect(shifted.names[shifted.keyByCode.LOSE!]).toBe('Отказ - дорого')
  })

  // Порядок строк не должен менять ни ключ, ни выбранное написание.
  it('результат не зависит от порядка строк', () => {
    const a = { STATUS_ID: '4', NAME: 'Отказ -Не складской ассортимент' }
    const b = { STATUS_ID: 'C4:4', NAME: 'Отказ - не складской ассортимент' }
    const direct = mergeReasons([a, b])
    const reversed = mergeReasons([b, a])
    expect(direct.keyByCode['4']).toBe(reversed.keyByCode['4'])
    expect(direct.names[direct.keyByCode['4']!]).toBe(reversed.names[reversed.keyByCode['4']!])
  })

  it('считает, сколько кодов свёрнуто', () => {
    // 8 кодов → 3 причины (дорого ×5, удалить ×1, нет количества ×2) → свёрнуто 5.
    expect(mergeReasons(live).foldedCodes).toBe(5)
  })

  // ⚠ Ключ не должен совпасть с кодом стадии: иначе стадия с именем «lose» склеилась бы с кодом
  // `LOSE` другой стадии и печатала бы чужое имя.
  it('каноничный ключ не пересекается с кодами портала', () => {
    const merged = mergeReasons([
      { STATUS_ID: 'LOSE', NAME: 'Отказ - дорого' },
      { STATUS_ID: 'X', NAME: 'lose' }
    ])
    expect(merged.keyByCode.X).not.toBe('LOSE')
    expect(merged.names[merged.keyByCode.X!]).toBe('lose')
  })

  it('стадия без названия остаётся под своим кодом и ни с чем не сводится', () => {
    const merged = mergeReasons([
      { STATUS_ID: 'A', NAME: '' },
      { STATUS_ID: 'B', NAME: null }
    ])
    expect(merged.keyByCode.A).toBe('A')
    expect(merged.keyByCode.B).toBe('B')
    expect(merged.reasons).toHaveLength(2)
    expect(merged.foldedCodes).toBe(0)
  })

  it('стадию без кода пропускает, имя из пробелов считает пустым', () => {
    const merged = mergeReasons([
      { STATUS_ID: '', NAME: 'Что-то', SEMANTICS: 'F' },
      { STATUS_ID: '   ', NAME: 'Ещё что-то', SEMANTICS: 'F' },
      { STATUS_ID: 'A', NAME: '   ' }
    ])
    expect(merged.reasons.map(r => r.key)).toEqual(['A'])
    expect(merged.keyByCode.A).toBe('A')
    expect(merged.names.A).toBe('A')
  })

  it('повтор кода не считается дважды', () => {
    const merged = mergeReasons([
      { STATUS_ID: 'LOSE', NAME: 'Дорого' },
      { STATUS_ID: 'LOSE', NAME: 'Дорого' }
    ])
    expect(merged.reasons[0]!.codes).toEqual(['LOSE'])
    expect(merged.foldedCodes).toBe(0)
  })

  it('пустой справочник — пустое сведение', () => {
    expect(mergeReasons([])).toEqual({ keyByCode: {}, names: {}, reasons: [], foldedCodes: 0 })
  })
})
