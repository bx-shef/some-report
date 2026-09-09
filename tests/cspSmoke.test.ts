import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PORTAL_HANDLER_ROUTES, PRERENDER_ROUTES } from '../app/config/routes'
import { HASH_PLACEHOLDER, buildHashDirective, extractInlineScripts, missingHashes } from '../scripts/cspHashes'
import { ASSET_CACHE_CONTROL, isViolationOf, ORIGINS_PLACEHOLDER, PAGES, cspProblems, directiveValue, embeddingProblems, extractCspHeader, firstAssetPath, headerProblems, isCspViolation, lostSecurityHeaders, markersInMarkup, parseOrigin, postPaths, routeOf, serve, substituteOrigins, uncoveredRoutes } from '../scripts/cspSmoke'

/**
 * Чистые части смоука. Сам прогон браузером в юнит-тестах не гоняется — он в CI отдельным
 * шагом после сборки; здесь сторожим то, что молча сделало бы его бесполезным.
 */
describe('extractCspHeader', () => {
  it('достаёт значение заголовка из боевого конфига', () => {
    const conf = readFileSync(join(import.meta.dirname, '..', 'nginx.conf'), 'utf-8')
    const csp = extractCspHeader(conf)
    expect(csp).toContain('script-src \'self\'')
    expect(csp).toContain(ORIGINS_PLACEHOLDER)
  })

  // ⚠ Конфиг без CSP — снятая защита. Смоук, молча прошедший по пустому заголовку, скрыл бы это.
  it('без директивы — ошибка, а не пустая строка', () => {
    expect(() => extractCspHeader('server { listen 8080; }')).toThrow('Content-Security-Policy')
  })

  // ⚠ Снятая «на время отладки» защита: строка закомментирована, текст на месте. Разбор без якоря
  // взял бы её как живую, и смоук прошёл бы под заголовком, которого прод не отдаёт.
  it('закомментированную директиву не считает', () => {
    expect(() => extractCspHeader('  # add_header Content-Security-Policy "default-src \'self\'" always;')).toThrow()
  })

  // Вторая директива в другом location — отдельная политика; молча взять первую — проверить не ту.
  it('две директивы — ошибка: смоук умеет проверять одну', () => {
    expect(() => extractCspHeader('add_header Content-Security-Policy "a";\n  add_header Content-Security-Policy "b";')).toThrow('2 директивы')
  })

  it('берёт значение с учётом отступа и флага always', () => {
    expect(extractCspHeader('server {\n    add_header Content-Security-Policy "a; b" always;\n}')).toBe('a; b')
  })
})

describe('substituteOrigins', () => {
  it('подставляет домены на оба места', () => {
    const csp = `connect-src 'self' ${ORIGINS_PLACEHOLDER}; frame-ancestors 'self' ${ORIGINS_PLACEHOLDER};`
    expect(substituteOrigins(csp, 'https://x.by')).not.toContain(ORIGINS_PLACEHOLDER)
    expect(substituteOrigins(csp, 'https://x.by').match(/https:\/\/x\.by/g)).toHaveLength(2)
  })
})

describe('isCspViolation', () => {
  // Дословные формулировки Chromium — ровно то, что было в консоли, когда импорт-карта не прошла.
  it('узнаёт сообщения Chromium о нарушении', () => {
    expect(isCspViolation('Refused to execute inline script because it violates the following Content Security Policy directive: "script-src \'self\'"')).toBe(true)
    expect(isCspViolation('Refused to load the script because it violates CSP')).toBe(true)
  })

  it('обычные сообщения не считает нарушением', () => {
    expect(isCspViolation('[NUXT_E5002]')).toBe(false)
    expect(isCspViolation('Failed to load resource: 404')).toBe(false)
  })
})

describe('cspProblems: что видно в ответе без браузера', () => {
  const html = readFileSync(join(import.meta.dirname, 'fixtures', 'nuxtPage.html'), 'utf-8')
  const good = `default-src 'self'; script-src 'self' ${buildHashDirective([html])}; style-src 'self' 'unsafe-inline'`

  it('боевой заголовок с хешами всех скриптов страницы — без замечаний', () => {
    expect(cspProblems(good, html)).toEqual([])
  })

  // ⚠ Страница без CSP открывается лучше всех — браузер о снятой защите не скажет ни слова.
  it('нет заголовка — одна проблема, и она называет причину', () => {
    expect(cspProblems(undefined, html)).toEqual(['нет заголовка Content-Security-Policy — защита снята целиком'])
    expect(cspProblems('', html)).toHaveLength(1)
  })

  it('unsafe-inline при полных хешах — ровно одно замечание', () => {
    expect(cspProblems(good.replace('script-src \'self\'', 'script-src \'self\' \'unsafe-inline\''), html))
      .toEqual(['в script-src есть \'unsafe-inline\' — защита от XSS снята'])
  })

  it('оставшийся плейсхолдер — замечание о нём плюс по одному на каждый непокрытый скрипт', () => {
    const problems = cspProblems(good.replace(/'sha256[^;]*/, HASH_PLACEHOLDER), html)
    expect(problems[0]).toContain(HASH_PLACEHOLDER)
    expect(problems).toHaveLength(1 + extractInlineScripts(html).length)
  })

  it('скрипт без хеша — замечание на каждый, с хешем и началом текста', () => {
    const problems = cspProblems('default-src \'self\'; script-src \'self\'', html)
    expect(problems).toHaveLength(extractInlineScripts(html).length)
    for (const problem of problems) expect(problem).toMatch(/'sha256-[A-Za-z0-9+/=]+' — «.+…»/)
  })

  it('нет script-src вовсе — замечание', () => {
    expect(cspProblems('default-src \'self\'', html)).toEqual(['в CSP нет script-src'])
  })

  // ⚠ `script-src-attr 'none'` перед `script-src` — законное ужесточение; regex по подстроке взял
  // бы его и объявил все скрипты непокрытыми.
  it('директиву ищет по точному имени, а не по подстроке', () => {
    expect(cspProblems(`script-src-attr 'none'; ${good}`, html)).toEqual([])
    expect(directiveValue('script-src-attr \'none\'; script-src \'self\' \'sha256-x\'', 'script-src')).toBe('\'self\' \'sha256-x\'')
    expect(directiveValue('default-src \'self\'', 'script-src')).toBeUndefined()
  })
})

describe('missingHashes', () => {
  it('одна проверка на сборку и смоук: хеш и начало текста', () => {
    const html = '<script>window.a = 1</script><script src="/x.js"></script>'
    const missing = missingHashes(html, '\'self\'')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.hash).toMatch(/^'sha256-/)
    expect(missing[0]?.snippet).toBe('window.a = 1…')
    expect(missingHashes(html, missing[0]!.hash)).toEqual([])
  })
})

describe('parseOrigin', () => {
  it('нормализует до origin', () => {
    expect(parseOrigin('http://localhost:8080/')).toBe('http://localhost:8080')
    expect(parseOrigin('https://example.com/app/?x=1')).toBe('https://example.com')
  })

  // `new URL('localhost:8080')` не бросает — схема «localhost:», origin «null».
  it('без схемы, с другой схемой и пустой — понятная ошибка', () => {
    for (const bad of ['localhost:8080', '127.0.0.1:8080', 'file:///tmp', undefined, '']) {
      expect(() => parseOrigin(bad)).toThrow('http(s)://host:port')
    }
  })
})

describe('postPaths', () => {
  // Портал открывает обработчики POST-запросом; без `error_page 405 =200` виджет пуст.
  // ⚠ С 2026-09-05 сюда входят и САМИ ОТЧЁТЫ: пункты CRM-аналитики ведут прямо в них, то есть
  // портал POST-ит на `/app/leads`, `/app/managers` и `/app/activity`. Забыть отчёт в списке значит узнать
  // о 405 от клиента, а не из смоука.
  it('обработчики плейсментов и установки, каталогами', () => {
    expect(postPaths(PORTAL_HANDLER_ROUTES)).toEqual(['/app/', '/app/leads/', '/app/managers/', '/app/activity/', '/install/'])
  })
})

describe('страницы смоука', () => {
  it('routeOf: путь смоука сводится к маршруту пререндера', () => {
    expect(routeOf('/')).toBe('/')
    expect(routeOf('/app/?preview=1')).toBe('/app')
    expect(routeOf('/install/')).toBe('/install')
    expect(routeOf('/install')).toBe('/install')
  })

  // ⚠ Копия списка маршрутов — то, что `app/config/routes.ts` прямо запрещает. Здесь список свой
  // (у каждой страницы свои маркеры), поэтому сторожим покрытие: новая страница без проверки в
  // смоуке уехала бы в статику непроверенной.
  it('покрывает все маршруты пререндера', () => {
    expect(uncoveredRoutes(PAGES, PRERENDER_ROUTES)).toEqual([])
    expect(uncoveredRoutes(PAGES, [...PRERENDER_ROUTES, '/settings'])).toEqual(['/settings'])
  })

  it('markersInMarkup: находит маркеры, которые есть в собранной странице', () => {
    const html = readFileSync(join(import.meta.dirname, 'fixtures', 'nuxtPage.html'), 'utf-8')
    const check = { path: '/install/', mustContain: ['Установка приложения', 'вне портала Битрикс24'] }
    expect(markersInMarkup(check, html)).toEqual(['Установка приложения'])
  })

  // ⚠ Маркер, который есть в SSR-разметке, не отличает живую страницу от мёртвой: заголовок
  // «Установка приложения» был на экране и у заблокированной импорт-карты.
  it('у отчёта и установщика маркеры — тексты, которых нет в статической разметке', () => {
    const app = PAGES.find(p => p.path.startsWith('/app'))!
    const install = PAGES.find(p => p.path.startsWith('/install'))!
    expect(app.mustContain.length).toBeGreaterThan(0)
    expect(install.mustContain.length).toBeGreaterThan(0)
    expect(install.mustContain).not.toContain('Установка приложения')
  })
})

/** Сырой запрос: `fetch` схлопывает `..` в URL ещё на клиенте, а нам нужно отправить путь как есть. */
function rawGet(origin: string, path: string): Promise<{ status: number, type: string, csp: string, body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin)
    const req = request({ host: url.hostname, port: url.port, path, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', chunk => body += chunk)
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers['content-type'] ?? ''),
        csp: String(res.headers['content-security-policy'] ?? ''),
        body
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('serve: статика под боевым заголовком', () => {
  let dir = ''
  let server: Awaited<ReturnType<typeof serve>>

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'csp-smoke-'))
    const root = join(dir, 'public')
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<p>root</p>')
    writeFileSync(join(root, 'app', 'index.html'), '<p>app</p>')
    writeFileSync(join(root, 'bundle.js'), 'export {}')
    // Соседний каталог с тем же префиксом имени — ловушка для проверки `startsWith(root)`.
    mkdirSync(join(dir, 'public-secret'))
    writeFileSync(join(dir, 'public-secret', 'secret.txt'), 'secret')
    server = await serve(root, 'default-src \'self\'')
  })

  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('отдаёт страницу с заголовком CSP и типом html', async () => {
    const res = await rawGet(server.origin, '/')
    expect(res.status).toBe(200)
    expect(res.csp).toBe('default-src \'self\'')
    expect(res.type).toContain('text/html')
    expect(res.body).toBe('<p>root</p>')
  })

  it('каталогу отдаёт его index.html — как nginx с try_files', async () => {
    expect((await rawGet(server.origin, '/app/')).body).toBe('<p>app</p>')
  })

  // ⚠ Без верного MIME браузер молча не выполнит `<script type="module">` — и смоук увидел бы
  // «Nuxt не стартовал» там, где CSP ни при чём.
  it('скрипту отдаёт text/javascript', async () => {
    expect((await rawGet(server.origin, '/bundle.js')).type).toBe('text/javascript')
  })

  // Открытые `..` и `%2e%2e` схлопывает сам разбор URL — до сервера они не доходят. Доходит
  // `..` за кодированным слэшем `%2f`: его разбор не трогает, а `decodeURIComponent` раскрывает.
  it('за корень не выпускает — ни через .., ни через соседа с тем же префиксом', async () => {
    for (const path of ['/../public-secret/secret.txt', '/%2e%2e/public-secret/secret.txt']) {
      const res = await rawGet(server.origin, path)
      expect(res.status).not.toBe(200)
      expect(res.body).not.toContain('secret')
    }
    expect((await rawGet(server.origin, '/x%2f..%2f..%2fpublic-secret%2fsecret.txt')).status).toBe(403)
  })

  it('нет файла — 404, кривой percent-encoding — тоже ответ, а не падение процесса', async () => {
    expect((await rawGet(server.origin, '/nope.js')).status).toBe(404)
    expect((await rawGet(server.origin, '/%')).status).toBe(404)
    expect((await rawGet(server.origin, '/')).status).toBe(200)
  })
})

/**
 * ⛔ Директивы ВСТРАИВАНИЯ — самый неприятный класс инцидентов проекта: портал показывает пустую
 * область без единой ошибки в интерфейсе. Браузерная часть смоука их не видела никогда: страница
 * открывается вне фрейма и без запросов к REST.
 */
describe('embeddingProblems: frame-ancestors и connect-src', () => {
  const ORIGINS = 'https://*.bitrix24.by https://bitrix.ankron.by'
  const good = `default-src 'self'; connect-src 'self' ${ORIGINS}; frame-ancestors 'self' ${ORIGINS};`

  it('исправный заголовок замечаний не даёт', () => {
    expect(embeddingProblems(good)).toEqual([])
  })

  it('без заголовка вовсе — говорит, что проверять не по чему', () => {
    expect(embeddingProblems(undefined)).toEqual(['нет заголовка Content-Security-Policy — проверять встраивание не по чему'])
  })

  it('нет директивы — называет какой именно', () => {
    const problems = embeddingProblems(`default-src 'self'; connect-src 'self' ${ORIGINS};`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('нет frame-ancestors')
  })

  /**
   * ⛔ Ровно тот отказ, ради которого проверка и заведена. `NGINX_ENVSUBST_FILTER` в `Dockerfile`
   * перечисляет переменные поимённо: опечатка в фильтре оставляет `${…}` в живом заголовке,
   * браузер читает это как имя домена, и портал не проходит НИ ПО ОДНОЙ директиве.
   */
  it('уцелевший плейсхолдер ловится в ОБЕИХ директивах и НИЧЕГО лишнего не добавляет', () => {
    const problems = embeddingProblems(`connect-src 'self' ${ORIGINS_PLACEHOLDER}; frame-ancestors 'self' ${ORIGINS_PLACEHOLDER};`)
    // ⚠ Длина всего массива, а не только совпадений: ложное срабатывание соседней проверки
    // (пустой список, расхождение) при `filter(...)` осталось бы незамеченным.
    expect(problems).toHaveLength(2)
    expect(problems.every(p => p.includes(ORIGINS_PLACEHOLDER))).toBe(true)
  })

  /**
   * ⚠ Худший из вариантов: портал НАС ВСТРОИТ, но данные мы отдать не сможем. Выглядит как
   * «данных нет» — то есть как факт о CRM, а не как поломка настройки.
   */
  it('разошедшиеся списки — отдельное сообщение с обоими', () => {
    const problems = embeddingProblems(`connect-src 'self' ${ORIGINS}; frame-ancestors 'self' https://*.bitrix24.by;`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('РАЗОШЛИСЬ')
    expect(problems[0]).toContain('bitrix.ankron.by')
  })

  // Порядок доменов в конфиге — дело автора, расхождением он быть не должен.
  it('разный ПОРЯДОК доменов расхождением не считает', () => {
    const reversed = 'https://bitrix.ankron.by https://*.bitrix24.by'
    expect(embeddingProblems(`connect-src 'self' ${ORIGINS}; frame-ancestors 'self' ${reversed};`)).toEqual([])
  })

  // `'self'` у директив значит разное (мы как источник и мы как родитель) — в сравнение не идёт.
  it('лишний `self` расхождением не считает', () => {
    expect(embeddingProblems(`connect-src ${ORIGINS}; frame-ancestors 'self' ${ORIGINS};`)).toEqual([])
  })

  it('пустой список доменов называет пустым, а не молчит', () => {
    const problems = embeddingProblems('connect-src \'self\'; frame-ancestors \'self\';')
    expect(problems).toHaveLength(2)
    expect(problems.every(p => p.includes('ни одного домена портала'))).toBe(true)
  })

  // ⚠ `'none'` — не «пусто», а запрет всем: портал не встроит нас вообще, и это снова пустая
  // область без ошибки. Отличается от пустого списка и сообщением, и причиной.
  it('`none` называет запретом, а не пустым списком', () => {
    const problems = embeddingProblems('connect-src \'none\'; frame-ancestors \'none\';')
    expect(problems).toHaveLength(2)
    expect(problems.every(p => p.includes('запрещено всем'))).toBe(true)
  })

  it('звёздочка вместо списка — это отсутствие ограничения, и так и сказано', () => {
    const problems = embeddingProblems(`connect-src 'self' *; frame-ancestors 'self' *;`)
    expect(problems).toHaveLength(2)
    expect(problems.every(p => p.includes('стоит *'))).toBe(true)
  })

  /**
   * ⛔ Опечатка в домене опаснее звёздочки: список выглядит настоящим и проходит все остальные
   * проверки — он непустой, без `*`, обе директивы совпадают. А `https://*.by` — это любой сайт
   * зоны, который сможет встроить отчёт и получить данные CRM.
   */
  it('слишком широкий домен зоны ловится, хотя список выглядит настоящим', () => {
    const wide = 'https://*.by'
    const problems = embeddingProblems(`connect-src 'self' ${wide}; frame-ancestors 'self' ${wide};`)
    expect(problems).toHaveLength(2)
    expect(problems.every(p => p.includes('слишком широкий домен'))).toBe(true)
  })

  it('настоящий домен портала широким НЕ считается', () => {
    const ok = 'https://*.bitrix24.by https://bitrix.ankron.by'
    expect(embeddingProblems(`connect-src 'self' ${ok}; frame-ancestors 'self' ${ok};`)).toEqual([])
  })

  // ⚠ При отсутствии ОБЕИХ директив сравнивать нечего — и сообщения о расхождении быть не должно.
  it('нет обеих директив — два сообщения и ни одного про расхождение', () => {
    const problems = embeddingProblems('default-src \'self\';')
    expect(problems).toHaveLength(2)
    expect(problems.some(p => p.includes('РАЗОШЛИСЬ'))).toBe(false)
  })

  /**
   * ⚠ Следствия у директив РАЗНЫЕ, и человек в логе идёт чинить по этой строке. У `connect-src`
   * есть откат на `default-src`, у `frame-ancestors` отката нет вовсе.
   */
  it('отсутствие каждой директивы объясняется СВОИМ следствием', () => {
    const [noAncestors] = embeddingProblems('connect-src \'self\' https://a.b.c;') as [string]
    expect(noAncestors).toContain('встроить нас может кто угодно')
    const [noConnect] = embeddingProblems('frame-ancestors \'self\' https://a.b.c;') as [string]
    expect(noConnect).toContain('отчёт во фрейме будет пустым')
  })
})

/**
 * ⚠ Между текстом конфига и ответом лежит правило nginx «локация со своим `add_header` НЕ
 * наследует серверные». Заголовок, забытый в `location /_nuxt/`, в конфиге выглядит как обычная
 * строка выше по файлу — а до ассетов не доезжает.
 */
describe('headerProblems: кэш живого ответа', () => {
  const doc = { 'cache-control': 'no-cache' }
  const asset = { 'cache-control': ASSET_CACHE_CONTROL }

  it('исправные ответы замечаний не дают', () => {
    expect(headerProblems('document', doc)).toEqual([])
    expect(headerProblems('asset', asset)).toEqual([])
  })

  it('документ без Cache-Control — про старую сборку в портале, а не про «нет заголовка»', () => {
    const problems = headerProblems('document', {})
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('старую сборку')
  })

  it('документ с вечным кэшем ловится', () => {
    const [problem] = headerProblems('document', { 'cache-control': 'public, max-age=31536000' }) as [string]
    expect(problem).toContain('без no-cache')
  })

  /**
   * ⛔ Дефект живого выката: `expires 1y` печатает свой `Cache-Control`, и вместе с `add_header`
   * заголовок уходил ДВУМЯ строками. Проверка по подстроке `max-age` такое пропускает — поэтому
   * значение сравнивается целиком.
   */
  it('склеенные две политики кэша у ассета ловятся, хотя max-age на месте', () => {
    const [problem] = headerProblems('asset', { 'cache-control': 'max-age=31536000, public, immutable' }) as [string]
    expect(problem).toContain('ушёл дважды')
  })

  // ⚠ Причину не утверждаем: значение могли поменять и намеренно — тогда «ушёл дважды» отправило
  // бы чинить несуществующий дубль. Сообщение обязано называть обе возможности.
  it('изменённое значение кэша называет и вторую возможную причину', () => {
    const [problem] = headerProblems('asset', { 'cache-control': 'public, max-age=604800, immutable' }) as [string]
    expect(problem).toContain('значение поменяли')
  })

  it('ассет без Cache-Control — про бандл заново, а не про кэш вообще', () => {
    const [problem] = headerProblems('asset', {}) as [string]
    expect(problem).toContain('тянет бандл заново')
  })

  /**
   * ⚠ Регистр имён приводит сама функция: она экспортирована, и вызывающий с `Cache-Control`
   * получил бы правдоподобный, но неверный диагноз «заголовка нет».
   */
  it('имя заголовка в любом регистре читается одинаково', () => {
    expect(headerProblems('document', { 'Cache-Control': 'no-cache' })).toEqual([])
  })
})

/**
 * ⚠ Сверяем НАБОР заголовков ассета с документом, а не список в коде: `location /_nuxt/`
 * переобъявляет четыре заголовка, и перечислять их поимённо значило бы сторожить ровно те, о
 * которых вспомнил автор проверки, — а забывают как раз невспомненные.
 */
describe('lostSecurityHeaders: что потерялось в локации', () => {
  const full = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=()'
  }

  it('одинаковые наборы замечаний не дают', () => {
    expect(lostSecurityHeaders(full, full)).toEqual([])
  })

  it('потерянный nosniff называет с подсказкой про наследование', () => {
    const { 'x-content-type-options': _drop, ...withoutNosniff } = full
    const [problem] = lostSecurityHeaders(full, withoutNosniff) as [string]
    expect(problem).toContain('x-content-type-options')
    expect(problem).toContain('не наследует')
  })

  // ⛔ Ровно тот заголовок, о котором забыл я сам: локация повторяет его, а проверка знала два.
  it('потерянные Referrer-Policy и Permissions-Policy тоже ловятся', () => {
    const problems = lostSecurityHeaders(full, { 'x-content-type-options': 'nosniff' })
    expect(problems).toHaveLength(2)
    expect(problems.join(' ')).toContain('referrer-policy')
    expect(problems.join(' ')).toContain('permissions-policy')
  })

  // Заголовка нет НИ У КОГО — это не потеря в локации, а другой разговор: молчим.
  it('заголовок, которого нет и у документа, потерей не считает', () => {
    expect(lostSecurityHeaders({}, {})).toEqual([])
  })

  it('регистр имён не мешает', () => {
    expect(lostSecurityHeaders({ 'X-Content-Type-Options': 'nosniff' }, { 'x-content-type-options': 'nosniff' })).toEqual([])
  })
})

describe('firstAssetPath', () => {
  // Имя ассета несёт хеш и меняется каждой сборкой: захардкоженный путь проверял бы заголовки 404.
  it('берёт первый ассет из живой разметки', () => {
    const html = '<link rel="modulepreload" href="/_nuxt/entry.B1c2d3.js"><link rel="stylesheet" href="/_nuxt/main.Ab12.css">'
    expect(firstAssetPath(html)).toBe('/_nuxt/entry.B1c2d3.js')
  })

  it('в одинарных кавычках тоже находит', () => {
    expect(firstAssetPath('<script src=\'/_nuxt/x.mjs\'>')).toBe('/_nuxt/x.mjs')
  })

  /**
   * ⚠ Только `src`/`href`. В разметке есть JSON гидратации, и строка оттуда совпала бы с любой
   * кавычечной — смоук пошёл бы проверять заголовки несуществующего адреса и назвал бы 404
   * поломкой локации.
   */
  it('строку из полезной нагрузки за ассет не принимает', () => {
    const html = '<script type="application/json">{"path":"/_nuxt/fake.js"}</script><script src="/_nuxt/real.js"></script>'
    expect(firstAssetPath(html)).toBe('/_nuxt/real.js')
  })

  // Не нашёлся — это не «проверять нечего», а сигнал прогону: он скажет об этом отдельно.
  it('без ассетов возвращает undefined, а не пустую строку', () => {
    expect(firstAssetPath('<html><body>нет ассетов</body></html>')).toBeUndefined()
  })
})

/**
 * ⛔ Строки здесь — НЕ выдуманные: сняты с живого Chromium 2026-09-08 отдельным прогоном. Правило
 * проекта «стенд не щедрее реального» тут работает наоборот: стенд обязан быть таким же
 * КОВАРНЫМ, как настоящий браузер, иначе проверка встраивания зеленеет на чужом нарушении.
 */
describe('isViolationOf: отказ по НАЗВАННОЙ директиве', () => {
  const ANCESTORS = 'Refused to frame \'http://127.0.0.1:44117/\' because an ancestor violates the following Content Security Policy directive: "frame-ancestors \'self\'".'
  const FRAME_SRC = 'Refused to frame \'https://nested.invalid/\' because it violates the following Content Security Policy directive: "frame-src \'none\'".'
  const CONNECT = 'Refused to connect to \'https://blocked.invalid/probe\' because it violates the following Content Security Policy directive: "connect-src \'self\'".'

  it('свой отказ опознаёт', () => {
    expect(isViolationOf(ANCESTORS, 'frame-ancestors')).toBe(true)
    expect(isViolationOf(CONNECT, 'connect-src')).toBe(true)
  })

  /**
   * ⛔ Главный тест этого блока. У нас в политике стоит `frame-src 'none'`, и его нарушение
   * печатается тем же словом «frame». Совпадение по слову дало бы ЛОЖНЫЙ ЗЕЛЁНЫЙ: вложенный
   * фрейм закрыл бы проверку `frame-ancestors` вместо неё самой.
   */
  it('чужой отказ со словом «frame» своим НЕ считает', () => {
    expect(isViolationOf(FRAME_SRC, 'frame-ancestors')).toBe(false)
  })

  it('отказ по другой директиве не путает', () => {
    expect(isViolationOf(CONNECT, 'frame-ancestors')).toBe(false)
    expect(isViolationOf(ANCESTORS, 'connect-src')).toBe(false)
  })

  // Обычное сообщение страницы отказом не считается — иначе проверка зеленела бы от любого лога.
  it('сообщение, не похожее на нарушение CSP, отказом не считает', () => {
    expect(isViolationOf('в directive: "connect-src" всё хорошо', 'connect-src')).toBe(false)
  })
})
