import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractCspHeader } from '../scripts/cspSmoke'

/**
 * Сторож боевого конфига.
 *
 * ⚠ Заголовки — единственная часть проекта, ошибка в которой НЕ ловится ни типами, ни сборкой, ни
 * браузером разработчика: приложение выглядит исправным, а у клиента портал показывает пустую
 * область без единой ошибки в интерфейсе. Мы это уже проходили дважды — с `X-Frame-Options` и с
 * импорт-картой, заблокированной собственной CSP.
 */
const conf = readFileSync(join(import.meta.dirname, '..', 'nginx.conf'), 'utf-8')
// Тот же разбор, что у смоука: закомментированная строка за директиву не считается.
const cspLine = ((): string => {
  try {
    return extractCspHeader(conf)
  } catch {
    return ''
  }
})()

function directive(name: string): string {
  return new RegExp(`${name}[^;]*`).exec(cspLine)?.[0] ?? ''
}

describe('CSP боевого конфига', () => {
  it('заголовок вообще есть', () => {
    expect(cspLine).not.toBe('')
  })

  // ⚠ Оба списка задаются ОДНОЙ переменной и подставляются при старте контейнера. Зашитый список
  // означал бы отдельный образ на каждого коробочного клиента — и забытый домен у следующего.
  it('домены порталов вынесены в переменную, а не зашиты', () => {
    expect(directive('frame-ancestors')).toContain('${B24_PORTAL_ORIGINS}')
    expect(directive('connect-src')).toContain('${B24_PORTAL_ORIGINS}')
  })

  it('зашитых доменов Битрикс24 в заголовке не осталось', () => {
    expect(cspLine).not.toMatch(/bitrix24\./)
  })

  // Отчёт по назначению живёт во фрейме портала: `frame-ancestors` обязан пускать хоть кого-то.
  it('встраивание разрешено себе и порталам', () => {
    expect(directive('frame-ancestors')).toContain('\'self\'')
  })

  // ⚠ `X-Frame-Options` не умеет списка доменов и в части браузеров перебивает CSP — вместе с
  // `frame-ancestors` он снова даёт пустую область на месте виджета.
  // PDF-снимок грузит SVG в <img src="data:…"> и встраивает шрифты data-URL — без `data:` экспорт
  // сломается молча, только в консоли браузера.
  it('img-src и font-src разрешают data: — на них держится PDF-снимок', () => {
    expect(cspLine).toMatch(/img-src [^;]*\bdata:/)
    expect(cspLine).toMatch(/font-src [^;]*\bdata:/)
  })

  it('X-Frame-Options не ставится', () => {
    // Ищем ДИРЕКТИВУ, а не строку: в комментарии этот заголовок упомянут как раз затем, чтобы
    // объяснить, почему его здесь нет.
    expect(conf).not.toMatch(/^\s*add_header\s+X-Frame-Options/mi)
  })

  // ⚠ `'unsafe-inline'` в script-src снял бы защиту от XSS целиком: браузер перестал бы отличать
  // наш скрипт от вставленного через дыру. Инлайновые скрипты разрешены поимённо, хешами.
  it('script-src без unsafe-inline и с плейсхолдером хешей', () => {
    expect(directive('script-src')).not.toContain('unsafe-inline')
    expect(directive('script-src')).toContain('__CSP_SCRIPT_HASHES__')
  })

  // Портал открывает обработчик плейсмента POST-запросом; без этого на его месте пустота.
  it('POST по статике отвечает 200, а не 405', () => {
    expect(conf).toContain('error_page 405 =200 $uri')
  })
})

describe('Dockerfile', () => {
  const dockerfile = readFileSync(join(import.meta.dirname, '..', 'Dockerfile'), 'utf-8')

  // ⚠ Пустая переменная запретила бы встраивание ВСЕМ. Значение по умолчанию обязано быть в образе.
  it('задаёт непустое значение доменов по умолчанию', () => {
    const value = /ENV B24_PORTAL_ORIGINS="([^"]+)"/.exec(dockerfile)?.[1] ?? ''
    expect(value).toContain('https://*.bitrix24.by')
    expect(value.trim().length).toBeGreaterThan(20)
  })

  // ⚠ Ищем ДИРЕКТИВУ в начале строки, а не подстроку: закомментированная `# ENV …` содержит тот же
  // текст, а рантайм-подстановка при этом сломана — и подставлялись бы ВСЕ переменные окружения.
  const envsubstFilter = /^ENV NGINX_ENVSUBST_FILTER="([^"]+)"$/m.exec(dockerfile)?.[1] ?? ''

  it('фильтр подстановки вообще задан', () => {
    expect(envsubstFilter).not.toBe('')
  })

  /**
   * ⛔ Главная проверка фильтра, и она НЕ про конкретные имена. Список обязан покрывать КАЖДЫЙ
   * `${…}` конфига: забытая переменная не роняет nginx и не пишет в лог — она доезжает до браузера
   * текстом. `{"softFrom":"${PAYMENT_LOCK_SOFT_FROM}"}` разберётся как негодная настройка, и
   * блокировка молча не включится, а список порталов текстом даст пустую область вместо отчёта.
   *
   * Проверка написана от КОНФИГА, а не от списка имён: добавится переменная — тест покраснеет сам,
   * без правки здесь.
   */
  it('подставляет каждую переменную, которая есть в конфиге', () => {
    const used = [...conf.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]!)
    expect(used.length).toBeGreaterThan(0)
    const filter = new RegExp(envsubstFilter)
    for (const name of new Set(used)) expect(filter.test(name)).toBe(true)
  })

  /**
   * ⚠ И обратная сторона: фильтр не должен пускать СВОИ переменные nginx. Конфиг полон `$uri`,
   * `$host`, `$request_uri`, и подстановка одноимённой переменной окружения молча съела бы их —
   * `error_page 405 =200 $uri` превратился бы в `error_page 405 =200`, то есть портал снова увидел
   * бы пустоту вместо отчёта.
   */
  it('не пускает под подстановку собственные переменные nginx', () => {
    const filter = new RegExp(envsubstFilter)
    for (const name of ['uri', 'host', 'request_uri', 'args', 'scheme', 'document_root']) {
      expect(filter.test(name)).toBe(false)
    }
  })

  /**
   * ⚠ Якоря обязательны: без них под `B24_PORTAL_ORIGINS` попала бы и `SOMETHING_B24_PORTAL_ORIGINS_X`
   * из окружения сервера — то есть подстановку задавал бы кто угодно, кроме нас.
   */
  it('фильтр заякорен с обоих концов', () => {
    expect(envsubstFilter.startsWith('^')).toBe(true)
    expect(envsubstFilter.endsWith('$')).toBe(true)
  })

  /**
   * ⚠ Переменные блокировки в ОБРАЗЕ обязаны быть пустыми: даты живут только в `.env` сервера.
   * Значение по умолчанию в Dockerfile означало бы, что блокировка уехала в репозиторий — а его
   * видит заказчик.
   */
  it('даты блокировки в образе пустые — они задаются только на сервере', () => {
    for (const name of ['PAYMENT_LOCK_SOFT_FROM', 'PAYMENT_LOCK_HARD_FROM', 'PAYMENT_LOCK_OFF']) {
      expect(dockerfile).toMatch(new RegExp(`^ENV ${name}=""$`, 'm'))
    }
  })

  /**
   * ⚠ Списков переменных в Dockerfile ДВА: фильтр рантайма и аргумент `envsubst` на сборке. Первый
   * решает, что подставит контейнер, второй — что увидит `nginx -t` при сборке образа. Разойдясь,
   * они дадут проверку не того конфига, который поедет клиенту, а сегодня это расхождение ещё и
   * безвредно на вид: литерал `${X}` внутри строки `return` синтаксис nginx переживает.
   */
  it('оба списка переменных в Dockerfile совпадают', () => {
    const filtered = new Set(envsubstFilter.replace(/^\^\(?|\)?\$$/g, '').split('|'))
    const built = new Set([...(/envsubst '([^']+)'/.exec(dockerfile)?.[1] ?? '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1]!))
    expect(built.size).toBeGreaterThan(0)
    expect([...built].sort()).toEqual([...filtered].sort())
  })

  it('кладёт конфиг шаблоном, чтобы подстановка случилась при старте', () => {
    expect(dockerfile).toMatch(/^COPY --from=builder .*\/etc\/nginx\/templates\/default\.conf\.template$/m)
  })

  it('проверяет значение переменной до подстановки — при старте и при сборке', () => {
    expect(dockerfile).toMatch(/^COPY deploy\/validate-portal-origins\.sh \/docker-entrypoint\.d\/05-/m)
    expect(dockerfile).toMatch(/^RUN sh \/docker-entrypoint\.d\/05-validate-portal-origins\.sh/m)
  })

  // ⚠ Список порталов — часть ПРОДУКТА: приложение хостится одним экземпляром на всех клиентов,
  // и коробочный портал заказчика обязан быть в образе. Пропади он отсюда — клиент увидит пустую
  // область вместо отчёта, без единой ошибки в интерфейсе.
  it('коробочный портал заказчика есть в списке образа', () => {
    const value = /ENV B24_PORTAL_ORIGINS="([^"]+)"/.exec(dockerfile)?.[1] ?? ''
    expect(value.split(/\s+/)).toContain('https://bitrix.ankron.by')
  })
})

describe('docker-compose', () => {
  const compose = readFileSync(join(import.meta.dirname, '..', 'deploy', 'docker-compose.prod.yml'), 'utf-8')

  // ⚠ Строка вида `B24_PORTAL_ORIGINS: ${B24_PORTAL_ORIGINS:-…}` перебила бы список образа ПУСТЫМ
  // значением при пустой переменной в `.env` — и запретила бы встраивание всем.
  it('не задаёт список порталов сам — он приезжает с образом', () => {
    expect(compose).not.toMatch(/^\s*B24_PORTAL_ORIGINS\s*:/m)
  })
})

describe('validate-portal-origins.sh', () => {
  const script = join(import.meta.dirname, '..', 'deploy', 'validate-portal-origins.sh')
  const run = (value: string) => spawnSync('sh', [script], { env: { ...process.env, B24_PORTAL_ORIGINS: value }, encoding: 'utf-8' })

  it('пропускает список https-origin\'ов с wildcard', () => {
    expect(run('https://*.bitrix24.by https://bitrix.ankron.by').status).toBe(0)
  })

  // ⚠ envsubst не понимает синтаксис nginx: кавычка в значении разрывает строку заголовка, из CSP
  // выпадает `frame-ancestors` целиком, а рядом встаёт чужая директива. Конфиг при этом ВАЛИДЕН.
  it.each([
    ['инъекция директивы', 'https://evil.example" always; add_header X-Pwned "yes'],
    ['голая звёздочка', '*'],
    ['пустое значение', ''],
    ['http без TLS', 'http://plain.example'],
    ['битое имя хоста', 'https://bad..host'],
    ['точка с запятой', 'https://a.example;']
  ])('отвергает: %s', (_name, value) => {
    expect(run(value).status).not.toBe(0)
  })
})

describe('validate-payment-lock.sh', () => {
  const script = join(import.meta.dirname, '..', 'deploy', 'validate-payment-lock.sh')
  const run = (env: Record<string, string>) => spawnSync('sh', [script], {
    env: { ...process.env, PAYMENT_LOCK_SOFT_FROM: '', PAYMENT_LOCK_HARD_FROM: '', PAYMENT_LOCK_OFF: '', ...env },
    encoding: 'utf-8'
  })

  /** ⚠ Пустые значения — штатное состояние образа: блокировка настраивается только на сервере. */
  it('пустые значения законны — это «блокировки нет»', () => {
    const result = run({})
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('не настроена')
  })

  it('пропускает даты и рубильник', () => {
    expect(run({ PAYMENT_LOCK_SOFT_FROM: '2026-09-17', PAYMENT_LOCK_HARD_FROM: '2026-09-21' }).status).toBe(0)
    expect(run({ PAYMENT_LOCK_OFF: '1' }).stdout).toContain('снята рубильником')
  })

  /**
   * ⛔ Календарь проверяется, а не только формат. `2026-09-31` под шаблон подходит: контейнер
   * стартовал бы и бодро писал в лог «полная блокировка с 2026-09-31», а приложение такую дату
   * отбрасывает — то есть блокировки не было бы при полной уверенности, что она включена. Ровно
   * тот исход, ради предотвращения которого скрипт и роняет контейнер. Найдено проверкой PR #72.
   */
  it.each([
    ['31 сентября', '2026-09-31'],
    ['30 февраля', '2026-02-30'],
    ['29 февраля в невисокосный год', '2027-02-29'],
    ['тринадцатый месяц', '2026-13-01'],
    ['нулевой месяц', '2026-00-10'],
    ['нулевой день', '2026-09-00']
  ])('отвергает несуществующий день: %s', (_name, value) => {
    expect(run({ PAYMENT_LOCK_SOFT_FROM: value }).status).not.toBe(0)
  })

  /** ⚠ И обратная сторона: годные граничные дни обязаны проходить, иначе проверка бесполезна. */
  it.each([['конец месяца', '2026-09-30'], ['високосное 29 февраля', '2028-02-29'], ['конец года', '2026-12-31']])(
    'пропускает существующий день: %s',
    (_name, value) => {
      expect(run({ PAYMENT_LOCK_SOFT_FROM: value }).status).toBe(0)
    }
  )

  /**
   * ⚠ Сегодняшний день в логе — не украшение. Опечатку в ГОДЕ не отличит от верной даты никакая
   * проверка, а рядом с сегодняшним числом она бросается в глаза тому, кто запускает контейнер.
   */
  it('лог называет сегодняшний день рядом с датами блокировки', () => {
    const out = run({ PAYMENT_LOCK_SOFT_FROM: '2026-09-17', PAYMENT_LOCK_HARD_FROM: '2026-09-21' }).stdout
    expect(out).toMatch(/сегодня \d{4}-\d{2}-\d{2}/)
    expect(out).toContain('2026-09-17')
  })

  /**
   * ⚠ Значения уезжают ВНУТРЬ JSON-строки `return 200 '{"softFrom":"${…}"}'`: кавычка ломает либо
   * JSON, либо сам конфиг nginx. А опечатка в формате даёт ТИХО неработающую блокировку —
   * приложение на мусор отвечает «блокировки нет».
   */
  it.each([
    ['русский формат даты', { PAYMENT_LOCK_SOFT_FROM: '17.09.2026' }],
    ['дата без ведущих нулей', { PAYMENT_LOCK_SOFT_FROM: '2026-9-7' }],
    ['кавычка в значении', { PAYMENT_LOCK_HARD_FROM: '2026-09-21","off":"1' }],
    ['слово вместо даты', { PAYMENT_LOCK_HARD_FROM: 'завтра' }],
    ['мусор в рубильнике', { PAYMENT_LOCK_OFF: 'ага' }]
  ])('роняет контейнер: %s', (_name, env) => {
    expect(run(env as Record<string, string>).status).not.toBe(0)
  })
})
