import { describe, expect, it } from 'vitest'
import {
  checkPlacements,
  installVerdict,
  missingScopes,
  normalizeHandlerUrl,
  parseRegisteredPlacements
} from '~/utils/installDiagnostics'

const OURS = 'https://some-report.example.com/app'

describe('normalizeHandlerUrl', () => {
  it('срезает хвостовой слеш', () => {
    expect(normalizeHandlerUrl(`${OURS}/`)).toBe(normalizeHandlerUrl(OURS))
  })

  // Домен регистронезависим: иначе наша же привязка выглядела бы чужой, и страница по кругу
  // предлагала бы перепривязать исправную точку.
  it('не различает регистр схемы и домена', () => {
    expect(normalizeHandlerUrl('HTTPS://Some-Report.Example.COM/app')).toBe(normalizeHandlerUrl(OURS))
  })

  // А путь — различает: `/app` и `/App` на сервере это разные страницы.
  it('различает регистр пути', () => {
    expect(normalizeHandlerUrl('https://some-report.example.com/App')).not.toBe(normalizeHandlerUrl(OURS))
  })

  it('не падает на строке, которая не URL', () => {
    expect(normalizeHandlerUrl('  /app/  ')).toBe('/app')
    expect(normalizeHandlerUrl('   ')).toBe('')
  })
})

describe('parseRegisteredPlacements', () => {
  it('читает ответ портала в нижнем регистре ключей', () => {
    expect(parseRegisteredPlacements([{ placement: 'CRM_ANALYTICS_MENU', handler: OURS }]))
      .toEqual([{ code: 'CRM_ANALYTICS_MENU', handler: OURS }])
  })

  // Регистрируем параметрами PLACEMENT/HANDLER — не полагаемся на то, каким регистром портал
  // отдаст их обратно.
  it('читает ответ и в верхнем регистре ключей', () => {
    expect(parseRegisteredPlacements([{ PLACEMENT: 'CRM_ANALYTICS_MENU', HANDLER: OURS }]))
      .toEqual([{ code: 'CRM_ANALYTICS_MENU', handler: OURS }])
  })

  it('пропускает мусор вместо того, чтобы падать', () => {
    expect(parseRegisteredPlacements([null, 'нет', { handler: OURS }, 42])).toEqual([])
    expect(parseRegisteredPlacements(undefined)).toEqual([])
    expect(parseRegisteredPlacements({ placement: 'X' })).toEqual([])
  })
})

describe('checkPlacements', () => {
  const expected = ['CRM_ANALYTICS_MENU', 'CRM_ANALYTICS_TOOLBAR']

  it('считает точку рабочей, когда она привязана на наш адрес', () => {
    const result = checkPlacements(expected, [
      { code: 'CRM_ANALYTICS_MENU', handler: OURS },
      { code: 'CRM_ANALYTICS_TOOLBAR', handler: `${OURS}/` }
    ], OURS)
    expect(result.map(r => r.status)).toEqual(['ok', 'ok'])
  })

  it('видит непривязанную точку', () => {
    const result = checkPlacements(expected, [{ code: 'CRM_ANALYTICS_MENU', handler: OURS }], OURS)
    expect(result[1]).toEqual({ code: 'CRM_ANALYTICS_TOOLBAR', status: 'missing', foreignHandlers: [] })
  })

  // Переезд домена: пункт в меню есть, а открывает он прошлое приложение. По ответу
  // `placement.bind` это неотличимо от исправной установки — отсюда и проверка.
  it('видит привязку на чужой адрес и показывает его', () => {
    const old = 'https://old-domain.example.com/app'
    const result = checkPlacements(expected, [{ code: 'CRM_ANALYTICS_MENU', handler: old }], OURS)
    expect(result[0]).toEqual({ code: 'CRM_ANALYTICS_MENU', status: 'other-handler', foreignHandlers: [old] })
  })

  it('считает точку рабочей, если наша привязка есть рядом с чужой', () => {
    const old = 'https://old-domain.example.com/app'
    const result = checkPlacements(['CRM_ANALYTICS_MENU'], [
      { code: 'CRM_ANALYTICS_MENU', handler: old },
      { code: 'CRM_ANALYTICS_MENU', handler: OURS }
    ], OURS)
    expect(result[0]?.status).toBe('ok')
    expect(result[0]?.foreignHandlers).toEqual([old])
  })
})

describe('missingScopes', () => {
  it('находит недостающие права', () => {
    expect(missingScopes(['crm', 'user_brief'], ['crm', 'placement', 'user_brief'])).toEqual(['placement'])
  })

  it('не различает регистр и пробелы', () => {
    expect(missingScopes([' CRM ', 'placement', 'user_brief'], ['crm', 'placement', 'user_brief'])).toEqual([])
  })
})

describe('installVerdict', () => {
  const okPlacements = [
    { code: 'CRM_ANALYTICS_MENU', status: 'ok' as const, foreignHandlers: [] },
    { code: 'CRM_ANALYTICS_TOOLBAR', status: 'ok' as const, foreignHandlers: [] }
  ]

  // Порядок проверок — это порядок лечения: пока нет прав, разбираться с точками бессмысленно.
  it('сначала жалуется на права, даже если и точки не привязаны', () => {
    const verdict = installVerdict({
      missing: ['crm'],
      placementsChecked: true,
      placements: [{ code: 'CRM_ANALYTICS_MENU', status: 'missing', foreignHandlers: [] }],
      appInstalled: false
    })
    expect(verdict.level).toBe('error')
    expect(verdict.title).toContain('crm')
  })

  it('не-администратору объясняет, что права выдаёт администратор', () => {
    expect(installVerdict({ missing: ['placement'], placementsChecked: true, placements: [], isAdmin: false }).hint)
      .toContain('администратор')
  })

  // Ровно тот случай, который и привёл к этой странице: точки привязаны, «Готово» показано,
  // а портал считает приложение неустановленным — и не показывает пункт.
  it('ловит незавершённую установку при привязанных точках', () => {
    const verdict = installVerdict({ missing: [], placementsChecked: true, placements: okPlacements, appInstalled: false })
    expect(verdict.level).toBe('error')
    expect(verdict.title).toContain('неустановленным')
  })

  it('называет непривязанные точки поимённо', () => {
    const verdict = installVerdict({
      missing: [],
      appInstalled: true,
      placementsChecked: true,
      placements: [
        { code: 'CRM_ANALYTICS_MENU', status: 'ok', foreignHandlers: [] },
        { code: 'CRM_ANALYTICS_TOOLBAR', status: 'missing', foreignHandlers: [] }
      ]
    })
    expect(verdict.level).toBe('error')
    expect(verdict.title).toContain('CRM_ANALYTICS_TOOLBAR')
    expect(verdict.title).not.toContain('CRM_ANALYTICS_MENU')
  })

  it('на чужой адрес предупреждает и показывает его', () => {
    const verdict = installVerdict({
      missing: [],
      appInstalled: true,
      placementsChecked: true,
      placements: [{ code: 'CRM_ANALYTICS_MENU', status: 'other-handler', foreignHandlers: ['https://old/app'] }]
    })
    expect(verdict.level).toBe('warning')
    expect(verdict.hint).toContain('https://old/app')
  })

  // `app.info` мог не ответить — это не повод объявлять установку сломанной.
  it('при неизвестном статусе установки и исправных точках даёт «всё хорошо»', () => {
    const verdict = installVerdict({ missing: [], placementsChecked: true, placements: okPlacements })
    expect(verdict.level).toBe('ok')
    expect(verdict.hint).toContain('CRM-аналитика')
  })

  it('в успешном случае подсказывает перезагрузить портал — пункт кэшируется', () => {
    expect(installVerdict({ missing: [], appInstalled: true, placementsChecked: true, placements: okPlacements }).hint)
      .toContain('перезагрузите')
  })
  // ⚠ Тест оплачен тем же дефектом, который лечит вся страница. Сбой `placement.get` приносил
  // сюда пустой список, неотличимый от «точек не ожидалось», и вердикт падал в зелёное
  // «всё зарегистрировано» — не проверив НИЧЕГО.
  it('не проверенные точки — не «всё хорошо»', () => {
    const verdict = installVerdict({ missing: [], appInstalled: true, placementsChecked: false, placements: [] })
    expect(verdict.level).not.toBe('ok')
    expect(verdict.title).toContain('Не удалось проверить')
  })

  // Права и незавершённая установка объясняют картину лучше, чем «не смогли спросить».
  it('о правах говорит раньше, чем о непроверенных точках', () => {
    expect(installVerdict({ missing: ['crm'], placementsChecked: false, placements: [] }).title).toContain('crm')
  })

  // Портал может вернуть запись без адреса — подсказка «открывает .» бесполезна.
  it('пустой чужой адрес не печатает', () => {
    const verdict = installVerdict({
      missing: [],
      appInstalled: true,
      placementsChecked: true,
      placements: [{ code: 'CRM_ANALYTICS_MENU', status: 'other-handler', foreignHandlers: [''] }]
    })
    expect(verdict.hint).toContain('другой адрес')
    expect(verdict.hint).not.toContain('открывает .')
  })
})
