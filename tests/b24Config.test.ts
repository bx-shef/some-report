import { describe, expect, it } from 'vitest'
import {
  B24_REQUIRED_SCOPES,
  LEGACY_PLACEMENT_CODES,
  PLACEMENTS,
  PLACEMENT_ANALYTICS_MENU,
  placementHandlerUrl,
  placementHandlers,
  portalAnalyticsUrl
} from '~/config/b24'
import { APP_REPORTS } from '~/config/routes'

describe('права приложения', () => {
  // В CRM отчёт только читает (свой отбор он пишет в `user.option`, а на это права не нужно).
  // Появление права на запись в этом списке — повод для разговора, а не строчка в диффе: оно
  // требует ПЕРЕсогласования на всех установленных порталах.
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
  // Решение владельца от 2026-09-05: в CRM-аналитике две ссылки, по одной на отчёт, без
  // промежуточной страницы выбора.
  it('регистрируем два пункта меню аналитики — по одному на отчёт', () => {
    expect(PLACEMENTS.map(p => p.code)).toEqual([PLACEMENT_ANALYTICS_MENU, PLACEMENT_ANALYTICS_MENU])
    expect(PLACEMENTS.map(p => p.path)).toEqual(APP_REPORTS.map(report => report.path))
  })

  // Заголовок пункта — то, что человек видит в меню портала. Пустой заголовок дал бы там
  // безымянную строку, и заметили бы это только после установки клиенту.
  it('у каждого пункта свой непустой заголовок', () => {
    const titles = PLACEMENTS.map(p => p.title.trim())
    expect(titles.every(title => title !== '')).toBe(true)
    expect(new Set(titles).size).toBe(titles.length)
  })

  // Кнопку в шапке аналитики приложение больше не регистрирует, но обязано СНИМАТЬ: иначе после
  // обновления рядом с двумя новыми пунктами остаётся третий вход в прошлую версию.
  it('прежние точки помним, чтобы снять их при установке', () => {
    expect(LEGACY_PLACEMENT_CODES).toContain('CRM_ANALYTICS_TOOLBAR')
    expect(PLACEMENTS.map(p => p.code)).not.toContain('CRM_ANALYTICS_TOOLBAR')
  })
})

describe('placementHandlers', () => {
  it('каждому пункту — свой адрес отчёта', () => {
    expect(placementHandlers('https://report.example.com')).toEqual([
      { code: PLACEMENT_ANALYTICS_MENU, title: 'Аналитика по лидам', handler: 'https://report.example.com/app/leads' },
      { code: PLACEMENT_ANALYTICS_MENU, title: 'Сделки по менеджерам', handler: 'https://report.example.com/app/managers' }
    ])
  })

  // Половина зарегистрированных пунктов хуже, чем ни одного: человек нашёл бы один отчёт и
  // считал бы, что второго нет.
  it('без публичного адреса не регистрируем ничего', () => {
    expect(placementHandlers('')).toBeNull()
  })
})

describe('placementHandlerUrl', () => {
  it('строит абсолютный адрес обработчика', () => {
    expect(placementHandlerUrl('https://report.example.com', '/app/leads')).toBe('https://report.example.com/app/leads')
  })

  it('срезает хвостовой слеш, чтобы не получить двойной', () => {
    expect(placementHandlerUrl('https://report.example.com/', '/app')).toBe('https://report.example.com/app')
  })

  // Пустой или относительный адрес дал бы зарегистрированный плейсмент, открывающий пустоту, —
  // и узнали бы мы об этом от клиента.
  it.each([
    ['пусто', ''],
    ['пробелы', '   '],
    ['относительный', '/report'],
    ['без TLS', 'http://report.example.com']
  ])('%s → null, а не битый плейсмент', (_name, value) => {
    expect(placementHandlerUrl(value, '/app')).toBeNull()
  })
})

describe('portalAnalyticsUrl', () => {
  it('строит адрес раздела CRM-аналитики портала', () => {
    expect(portalAnalyticsUrl('https://example.bitrix24.by')).toBe('https://example.bitrix24.by/report/analytics/')
  })

  it('срезает хвостовой слеш, чтобы не получить двойной', () => {
    expect(portalAnalyticsUrl('https://example.bitrix24.by/')).toBe('https://example.bitrix24.by/report/analytics/')
  })

  // `targetOrigin()` вне фрейма отдаёт `?` — ссылку на такое строить нельзя.
  it('без адреса портала ссылки нет', () => {
    expect(portalAnalyticsUrl('?')).toBeNull()
    expect(portalAnalyticsUrl('')).toBeNull()
  })
})
