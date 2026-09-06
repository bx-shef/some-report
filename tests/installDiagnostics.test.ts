import { describe, expect, it } from 'vitest'
import {
  checkPlacements,
  extraPlacements,
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
  const LEADS = `${OURS}/leads`
  const MANAGERS = `${OURS}/managers`
  /** Два пункта в ОДНОЙ точке — по одному на отчёт: ровно то, что регистрирует установка. */
  const expected = [
    { code: 'CRM_ANALYTICS_MENU', handler: LEADS, title: 'Аналитика по лидам' },
    { code: 'CRM_ANALYTICS_MENU', handler: MANAGERS, title: 'Сделки по менеджерам' }
  ]

  it('считает пункт рабочим, когда он привязан на наш адрес', () => {
    const result = checkPlacements(expected, [
      { code: 'CRM_ANALYTICS_MENU', handler: LEADS },
      { code: 'CRM_ANALYTICS_MENU', handler: `${MANAGERS}/` }
    ])
    expect(result.map(r => r.status)).toEqual(['ok', 'ok'])
  })

  /**
   * ⚠ Главное, ради чего проверка знает про АДРЕСА, а не только про коды точек: привязан один
   * отчёт из двух. По коду точки это выглядело бы как исправная установка, а человек открыл бы
   * аналитику и не нашёл там второго отчёта.
   *
   * ⚠ И статус именно `missing`, а не `other-handler`: соседний пункт — НАШ ЖЕ второй отчёт, и
   * называть его «чужим адресом» значит показать администратору подсказку «пункт открывает
   * https://…/app/leads» с совершенно исправным адресом вместо «второй отчёт не зарегистрирован».
   */
  it('видит непривязанный пункт, когда точка та же', () => {
    const result = checkPlacements(expected, [{ code: 'CRM_ANALYTICS_MENU', handler: LEADS }])
    expect(result.map(r => r.status)).toEqual(['ok', 'missing'])
    expect(result[0]?.foreignHandlers).toEqual([])
    expect(result[1]?.foreignHandlers).toEqual([])
  })

  // Переезд домена при двух пунктах: чужой адрес — действительно чужой, и его надо показать.
  it('чужой адрес рядом с нашим не путается с соседним пунктом', () => {
    const old = 'https://old-domain.example.com/app'
    const result = checkPlacements(expected, [
      { code: 'CRM_ANALYTICS_MENU', handler: LEADS },
      { code: 'CRM_ANALYTICS_MENU', handler: old }
    ])
    expect(result.map(r => r.status)).toEqual(['ok', 'other-handler'])
    expect(result[0]?.foreignHandlers).toEqual([old])
    expect(result[1]?.foreignHandlers).toEqual([old])
  })

  it('видит точку, которой нет вовсе', () => {
    const result = checkPlacements(expected, [])
    expect(result.map(r => r.status)).toEqual(['missing', 'missing'])
    expect(result[0]?.title).toBe('Аналитика по лидам')
  })

  // Переезд домена: пункт в меню есть, а открывает он прошлое приложение. По ответу
  // `placement.bind` это неотличимо от исправной установки — отсюда и проверка.
  it('видит привязку на чужой адрес и показывает его', () => {
    const old = 'https://old-domain.example.com/app/leads'
    const result = checkPlacements([expected[0]!], [{ code: 'CRM_ANALYTICS_MENU', handler: old }])
    expect(result[0]?.status).toBe('other-handler')
    expect(result[0]?.foreignHandlers).toEqual([old])
  })

  it('считает пункт рабочим, если наша привязка есть рядом с чужой', () => {
    const old = 'https://old-domain.example.com/app'
    const result = checkPlacements([expected[0]!], [
      { code: 'CRM_ANALYTICS_MENU', handler: old },
      { code: 'CRM_ANALYTICS_MENU', handler: LEADS }
    ])
    expect(result[0]?.status).toBe('ok')
    expect(result[0]?.foreignHandlers).toEqual([old])
  })
})

describe('extraPlacements', () => {
  const LEADS = `${OURS}/leads`
  const expected = [{ code: 'CRM_ANALYTICS_MENU', handler: LEADS }]

  // Наследство прошлой версии: пункт на главную приложения и кнопка в шапке аналитики. После
  // переустановки они остались бы рядом с новыми — три входа вместо двух.
  it('находит привязки, которых мы больше не регистрируем', () => {
    const extras = extraPlacements(expected, [
      { code: 'CRM_ANALYTICS_MENU', handler: LEADS },
      { code: 'CRM_ANALYTICS_MENU', handler: OURS },
      { code: 'CRM_ANALYTICS_TOOLBAR', handler: OURS }
    ])
    expect(extras.map(row => row.handler)).toEqual([OURS, OURS])
  })

  it('на чистой установке лишнего не находит', () => {
    expect(extraPlacements(expected, [{ code: 'CRM_ANALYTICS_MENU', handler: `${LEADS}/` }])).toEqual([])
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
    { code: 'CRM_ANALYTICS_MENU', handler: `${OURS}/leads`, title: 'Аналитика по лидам', status: 'ok' as const, foreignHandlers: [] },
    { code: 'CRM_ANALYTICS_MENU', handler: `${OURS}/managers`, title: 'Сделки по менеджерам', status: 'ok' as const, foreignHandlers: [] }
  ]

  // Порядок проверок — это порядок лечения: пока нет прав, разбираться с точками бессмысленно.
  it('сначала жалуется на права, даже если и точки не привязаны', () => {
    const verdict = installVerdict({
      missing: ['crm'],
      placementsChecked: true,
      placements: [{ code: 'CRM_ANALYTICS_MENU', handler: OURS, status: 'missing', foreignHandlers: [] }],
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

  // Называем ОТЧЁТ, а не код точки: человеку на странице установки нужно понять, какой из двух
  // пунктов не появился в меню.
  it('называет непривязанные пункты по их заголовкам', () => {
    const verdict = installVerdict({
      missing: [],
      appInstalled: true,
      placementsChecked: true,
      placements: [
        okPlacements[0]!,
        { ...okPlacements[1]!, status: 'missing' as const }
      ]
    })
    expect(verdict.level).toBe('error')
    expect(verdict.title).toContain('Сделки по менеджерам')
    expect(verdict.title).not.toContain('Аналитика по лидам')
  })

  // ⚠ Переезд домена: верно и «наши пункты не найдены», и «прежние висят лишними». Причина одна —
  // сменился адрес приложения, — и назвать надо её, а не «наследство прошлой версии»: лечится
  // одинаково, а понимается по-разному.
  it('о чужом адресе говорит раньше, чем о лишних пунктах', () => {
    const old = 'https://old-domain.example.com/app/leads'
    const verdict = installVerdict({
      missing: [],
      appInstalled: true,
      placementsChecked: true,
      placements: [{ ...okPlacements[0]!, status: 'other-handler' as const, foreignHandlers: [old] }],
      extras: [{ code: 'CRM_ANALYTICS_MENU', handler: old }]
    })
    expect(verdict.title).toContain('другой адрес')
    expect(verdict.hint).toContain(old)
  })

  // Лишний пункт из прошлой версии — предупреждение с понятным действием, а не тишина.
  it('говорит про лишние привязки и зовёт перепривязать', () => {
    const verdict = installVerdict({
      missing: [],
      appInstalled: true,
      placementsChecked: true,
      placements: okPlacements,
      extras: [{ code: 'CRM_ANALYTICS_TOOLBAR', handler: OURS }]
    })
    expect(verdict.level).toBe('warning')
    expect(verdict.hint).toContain('Перепривязать')
  })

  it('на чужой адрес предупреждает и показывает его', () => {
    const verdict = installVerdict({
      missing: [],
      appInstalled: true,
      placementsChecked: true,
      placements: [{ code: 'CRM_ANALYTICS_MENU', handler: OURS, status: 'other-handler', foreignHandlers: ['https://old/app'] }]
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
      placements: [{ code: 'CRM_ANALYTICS_MENU', handler: OURS, status: 'other-handler', foreignHandlers: [''] }]
    })
    expect(verdict.hint).toContain('другой адрес')
    expect(verdict.hint).not.toContain('открывает .')
  })
})
