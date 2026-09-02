import { describe, expect, it } from 'vitest'
import {
  B24_REQUIRED_SCOPES,
  PLACEMENTS,
  PLACEMENT_ANALYTICS_MENU,
  PLACEMENT_ANALYTICS_TOOLBAR,
  placementHandlerUrl
} from '~/config/b24'

describe('права приложения', () => {
  // Отчёт только читает. Появление права на запись в этом списке — повод для разговора, а не
  // строчка в диффе: оно требует ПЕРЕсогласования на всех установленных порталах.
  it('просит ровно три права и ни одного лишнего', () => {
    expect([...B24_REQUIRED_SCOPES].sort()).toEqual(['crm', 'placement', 'user_brief'])
  })

  // Точка CRM_ANALYTICS_MENU объявлена в скоупах `placement, crm`: без второго `placement.bind`
  // отвечает ERROR_PLACEMENT_NOT_FOUND.
  it('включает права, без которых точка встройки не регистрируется', () => {
    expect(B24_REQUIRED_SCOPES).toContain('placement')
    expect(B24_REQUIRED_SCOPES).toContain('crm')
  })
})

describe('плейсменты', () => {
  it('регистрируем обе точки раздела аналитики', () => {
    expect(PLACEMENTS.map(p => p.code)).toEqual([PLACEMENT_ANALYTICS_MENU, PLACEMENT_ANALYTICS_TOOLBAR])
  })

  it('у каждой точки есть заголовок пункта', () => {
    for (const placement of PLACEMENTS) expect(placement.title.trim()).not.toBe('')
  })
})

describe('placementHandlerUrl', () => {
  it('строит абсолютный адрес обработчика', () => {
    expect(placementHandlerUrl('https://report.example.com')).toBe('https://report.example.com/app')
  })

  it('срезает хвостовой слеш, чтобы не получить двойной', () => {
    expect(placementHandlerUrl('https://report.example.com/')).toBe('https://report.example.com/app')
  })

  // Пустой или относительный адрес дал бы зарегистрированный плейсмент, открывающий пустоту, —
  // и узнали бы мы об этом от клиента.
  it.each([
    ['пусто', ''],
    ['пробелы', '   '],
    ['относительный', '/report'],
    ['без TLS', 'http://report.example.com']
  ])('%s → null, а не битый плейсмент', (_name, value) => {
    expect(placementHandlerUrl(value)).toBeNull()
  })
})
