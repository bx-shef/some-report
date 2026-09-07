import { describe, expect, it } from 'vitest'
import { CALL_THRESHOLD_CHOICES, DEFAULT_CALL_THRESHOLD_SECONDS, thresholdLabel } from '~/types/activity'
import {
  ACTIVITY_OPTION_KEY,
  decodeActivityState,
  decodeLeadsState,
  decodeManagersState,
  encodeActivityState,
  encodeLeadsState,
  encodeManagersState,
  LEADS_OPTION_KEY,
  MANAGERS_OPTION_KEY
} from '~/utils/savedFilters'

/**
 * Отбор, запомненный порталом. Проверяем разбор: в настройках лежит то, что записала ПРОШЛАЯ
 * версия приложения и что человек мог унаследовать с другого портала. Восстановить негодное
 * молча значит открыть отчёт с отбором, которого никто не выбирал.
 */

const PERIOD = { from: '2026-09-01', to: '2026-09-30' }

describe('ключи настроек', () => {
  // Версия в ключе: формат отбора уже менялся дважды за две недели. Без неё старое значение
  // приехало бы в новый формат и было бы прочитано наполовину.
  it('несут версию формата', () => {
    expect(LEADS_OPTION_KEY).toMatch(/\.v\d+$/)
    expect(MANAGERS_OPTION_KEY).toMatch(/\.v\d+$/)
    expect(LEADS_OPTION_KEY).not.toBe(MANAGERS_OPTION_KEY)
  })
})

describe('отчёт по лидам', () => {
  it('туда и обратно — то же самое', () => {
    const filters = { sourceId: 'CALL', assignedById: 17 }
    expect(decodeLeadsState(encodeLeadsState(PERIOD, filters))).toEqual({ period: PERIOD, filters })
  })

  it('пустой отбор не восстанавливает пустых ключей', () => {
    expect(decodeLeadsState(encodeLeadsState(PERIOD, {}))).toEqual({ period: PERIOD })
  })

  // Портал отдаёт значение строкой; на всякий случай читаем и уже разобранный объект.
  it('читает и строку, и объект', () => {
    expect(decodeLeadsState({ period: PERIOD }).period).toEqual(PERIOD)
    expect(decodeLeadsState(JSON.stringify({ period: PERIOD })).period).toEqual(PERIOD)
  })

  it.each([
    ['мусор', 'не json'],
    ['пусто', ''],
    ['массив', '[1,2]'],
    ['ничего', undefined],
    ['число', 42]
  ])('%s — открываемся с умолчанием, а не падаем', (_name, value) => {
    expect(decodeLeadsState(value)).toEqual({})
  })

  /**
   * ⚠ Период проверяем той же проверкой, что и панель: иначе через настройки в отчёт заезжал бы
   * период, который через интерфейс выбрать нельзя, — перевёрнутый или длиной в пять лет. На
   * боевых объёмах второй случай — это минуты ожидания при открытии фрейма.
   */
  it.each([
    ['перевёрнутый', { from: '2026-09-30', to: '2026-09-01' }],
    ['длиной в годы', { from: '2020-01-01', to: '2026-09-30' }],
    ['не дата', { from: 'вчера', to: 'сегодня' }],
    ['31 февраля', { from: '2026-02-31', to: '2026-03-01' }],
    ['половина', { from: '2026-09-01' }]
  ])('негодный период (%s) отбрасывается', (_name, period) => {
    expect(decodeLeadsState(JSON.stringify({ period })).period).toBeUndefined()
  })

  it('чужие ключи фильтров не восстанавливаются', () => {
    const state = decodeLeadsState(JSON.stringify({ filters: { sourceId: 'CALL', вредный: 'ключ', assignedById: 'нет' } }))
    expect(state.filters).toEqual({ sourceId: 'CALL' })
  })
})

describe('отчёт по менеджерам', () => {
  it('туда и обратно — то же самое', () => {
    const filters = { categoryId: 2, scope: 'won' as const, period: PERIOD, companyId: 17 }
    expect(decodeManagersState(encodeManagersState(filters))).toEqual(filters)
  })

  // ⚠ Ноль — это «Без моей компании», а не «не задано». Потерять его значит открыть отчёт по
  // всем компаниям там, где человек выбрал сделки без компании.
  it('ноль в компании сохраняется как значение', () => {
    const saved = encodeManagersState({ categoryId: 0, scope: 'in-work', period: PERIOD, companyId: 0 })
    expect(decodeManagersState(saved).companyId).toBe(0)
  })

  it('без компании ключа в настройке нет', () => {
    const saved = encodeManagersState({ categoryId: 0, scope: 'in-work', period: PERIOD })
    expect(JSON.parse(saved)).not.toHaveProperty('companyId')
    expect(decodeManagersState(saved).companyId).toBeUndefined()
  })

  // Направление 0 — «Общее», полноценное значение фильтра, а не «не выбрано».
  it('нулевое направление сохраняется', () => {
    expect(decodeManagersState(JSON.stringify({ categoryId: 0 })).categoryId).toBe(0)
  })

  it('незнакомый охват отбрасывается', () => {
    expect(decodeManagersState(JSON.stringify({ scope: 'чужой' })).scope).toBeUndefined()
    expect(decodeManagersState(JSON.stringify({ scope: 'lost' })).scope).toBe('lost')
  })

  /**
   * ⚠ Свойства прототипа — не значения охвата. Проверка через `in` пропускала бы `toString` и
   * `constructor`, а экран печатает `SCOPE_LABELS[scope].toLowerCase()` — то есть падал бы на
   * пустом месте, показав вместо отчёта белый экран.
   */
  it.each(['toString', 'constructor', 'hasOwnProperty'])('охват «%s» из прототипа не проходит', (scope) => {
    expect(decodeManagersState(JSON.stringify({ scope })).scope).toBeUndefined()
  })

  /**
   * ⚠ `Number()` превращает `null` в 0, `true` в 1, а `[5]` в 5. Сохранённое `{"companyId": true}`
   * восстановилось бы фильтром по компании №1, которого человек не выбирал, — ровно тот дефект,
   * от которого написан весь модуль.
   */
  it.each([
    ['null', null],
    ['true', true],
    ['false', false],
    ['пустой массив', []],
    ['массив с числом', [5]],
    ['объект', { id: 5 }],
    ['дробное', 1.5],
    ['отрицательное', -3]
  ])('%s в компании и направлении не восстанавливается', (_name, value) => {
    const state = decodeManagersState(JSON.stringify({ companyId: value, categoryId: value }))
    expect(state.companyId).toBeUndefined()
    expect(state.categoryId).toBeUndefined()
  })

  it('мусор в настройке — открываемся с умолчанием', () => {
    expect(decodeManagersState('{')).toEqual({})
    expect(decodeManagersState(null)).toEqual({})
  })

  /**
   * ⚠ Случай обновления, а не выдуманный: в прошлой версии у фильтра был пункт «Все компании» со
   * значением −1, и он лежит в `user.option` у всех, кто успел его выбрать. Компанию на экране
   * теперь показывают по одной, и такого значения больше нет.
   *
   * Восстановиться оно НЕ должно: `MYCOMPANY_ID: -1` — это фильтр, под который не подходит ни одна
   * сделка, и человек открыл бы отчёт с пустым экраном вместо своих чисел. Отброшенное значение
   * означает «компания не выбрана», а это ровно то, при чём отчёт открывает самую крупную.
   */
  it('прежние «Все компании» (−1) из настройки не восстанавливаются', () => {
    const saved = JSON.stringify({ categoryId: 0, scope: 'in-work', companyId: -1 })
    const state = decodeManagersState(saved)
    expect(state.companyId).toBeUndefined()
    // Остальной отбор при этом уцелел: негодным было одно поле, а не вся настройка.
    expect(state.scope).toBe('in-work')
  })
})

describe('отбор отчёта «Активность пользователей»', () => {
  const FILTERS = { period: PERIOD, departmentId: 62, thresholdSeconds: 29 }

  it('ключ версионирован, как у соседей', () => {
    expect(ACTIVITY_OPTION_KEY).toBe('report.activity.v1')
  })

  it('сохранённое возвращается тем же', () => {
    expect(decodeActivityState(encodeActivityState(FILTERS), 31)).toEqual(FILTERS)
  })

  it('без отдела — значит все отделы, а не отдел с номером ноль', () => {
    const saved = encodeActivityState({ period: PERIOD, thresholdSeconds: 29 })
    expect(decodeActivityState(saved, 31).departmentId).toBeUndefined()
    // ⚠ Ноль отделом не бывает: `readNumber` без `allowZero` его и не пропустит.
    expect(decodeActivityState('{"departmentId":0}', 31).departmentId).toBeUndefined()
  })

  /**
   * ⚠ У отчёта 3 СВОЙ предел периода — месяц: звонки лежат строками в памяти фрейма. Квартал,
   * сохранённый прошлой версией приложения, панель выбрать не даст, а отчёт посчитал бы.
   */
  it('период длиннее предела ЭТОГО отчёта отвергается', () => {
    const quarter = JSON.stringify({ period: { from: '2026-07-01', to: '2026-09-30' }, thresholdSeconds: 29 })
    expect(decodeActivityState(quarter, 31).period).toBeUndefined()
    // Без предела тот же период годен — значит отвергает именно предел, а не разбор вообще.
    expect(decodeActivityState(quarter).period).toEqual({ from: '2026-07-01', to: '2026-09-30' })
  })

  it('перевёрнутый период отвергается', () => {
    expect(decodeActivityState('{"period":{"from":"2026-09-30","to":"2026-09-01"}}', 31).period).toBeUndefined()
  })

  /**
   * ⚠ Порог — не «любое неотрицательное число»: панель предлагает шесть значений. Восстановленное
   * 47 показало бы в панели пустой выбор, пока числа на экране считаются по 47.
   */
  it('порог не из списка выбора отвергается', () => {
    for (const seconds of [47, 1, 30, 3600, -5, 1.5]) {
      expect(decodeActivityState(`{"thresholdSeconds":${seconds}}`, 31).thresholdSeconds).toBeUndefined()
    }
  })

  it('порог из списка восстанавливается, включая ноль', () => {
    expect(decodeActivityState('{"thresholdSeconds":0}', 31).thresholdSeconds).toBe(0)
    expect(decodeActivityState('{"thresholdSeconds":119}', 31).thresholdSeconds).toBe(119)
  })

  // ⚠ Ноль здесь ЗНАЧЕНИЕ («считать все разговоры»), а не «не задано»: потеряв его, отчёт молча
  // вернулся бы к порогу заказчика и показал другие числа.
  it('ноль как порог сохраняется, а не теряется', () => {
    const saved = encodeActivityState({ period: PERIOD, thresholdSeconds: 0 })
    expect(decodeActivityState(saved, 31).thresholdSeconds).toBe(0)
  })

  it('мусор в настройке открывает отчёт с умолчанием, а не падает', () => {
    for (const raw of [undefined, null, '', '   ', 'не json', '[]', '42', '{"period":true,"thresholdSeconds":"много"}']) {
      expect(() => decodeActivityState(raw, 31)).not.toThrow()
      expect(decodeActivityState(raw, 31)).toEqual({})
    }
  })

  /**
   * ⚠ Имена из прототипа — обычный мусор, а не особый класс атаки: у отчёта 3 нет поиска
   * `ключ in объект` (он есть у отчёта 2 для `scope`, и вот там это уязвимость). Проверяем
   * потому, что «constructor» выглядит правдоподобнее «abc» и через `Number()` даёт `NaN` тем же
   * путём — и если кто-то заменит `readNumber` на менее придирчивый разбор, тест покраснеет.
   */
  it('имена служебных свойств за настройку не принимаются', () => {
    for (const value of ['constructor', 'valueOf', 'toString', '__proto__', 'abc']) {
      expect(decodeActivityState(`{"thresholdSeconds":"${value}"}`, 31).thresholdSeconds).toBeUndefined()
      expect(decodeActivityState(`{"departmentId":"${value}"}`, 31).departmentId).toBeUndefined()
    }
  })

  /**
   * ⚠ Портал документирует значение `user.option.get` как `object | string | null` и отдаёт его
   * КАК ЕСТЬ. У отчёта 1 такой тест есть, у отчёта 3 не было: приём только строки воспроизвёл бы
   * ровно тот симптом, ради которого разбор и написан терпимым.
   */
  it('читает и строку, и уже разобранный объект', () => {
    const asObject = { period: PERIOD, departmentId: 62, thresholdSeconds: 0 }
    expect(decodeActivityState(asObject, 31)).toEqual(asObject)
    expect(decodeActivityState(JSON.stringify(asObject), 31)).toEqual(asObject)
  })
})

describe('подписи порогов', () => {
  /**
   * ⚠ Подписи видит человек, а теста на них не было: перенос списка из панели в типы уже был
   * поводом их сломать, и все шесть пришлось сверять посимвольно вручную.
   */
  it('все шесть подписей — ровно те, что были', () => {
    expect(CALL_THRESHOLD_CHOICES.map(thresholdLabel)).toEqual([
      'Считать все разговоры',
      'Дольше 9 с',
      'Дольше 19 с',
      'Дольше 29 с (как было)',
      'Дольше 59 с',
      'Дольше 119 с'
    ])
  })

  // ⚠ «как было» — только у порога заказчика: это правило из прежнего отчёта, и человек должен
  // узнавать его в списке с первого взгляда.
  it('«как было» стоит ровно у порога заказчика', () => {
    const marked = CALL_THRESHOLD_CHOICES.filter(seconds => thresholdLabel(seconds).includes('как было'))
    expect(marked).toEqual([DEFAULT_CALL_THRESHOLD_SECONDS])
  })

  it('ноль — не «дольше 0 с», а словами', () => {
    expect(thresholdLabel(0)).toBe('Считать все разговоры')
  })
})

describe('граница периода отчёта 3', () => {
  // ⚠ Ровно предел проходит, предел плюс день — нет. Строгое сравнение легко превратить в
  // нестрогое, и тогда в отчёт заедет период на день длиннее разрешённого панелью.
  it('ровно 31 день проходит, 32 — нет', () => {
    const month = JSON.stringify({ period: { from: '2026-09-01', to: '2026-10-01' } })
    const longer = JSON.stringify({ period: { from: '2026-09-01', to: '2026-10-02' } })
    expect(decodeActivityState(month, 31).period).toEqual({ from: '2026-09-01', to: '2026-10-01' })
    expect(decodeActivityState(longer, 31).period).toBeUndefined()
  })
})
