import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRERENDER_ROUTES, SERVICE_ROUTES } from '../app/config/routes'
import { HASH_PLACEHOLDER, buildHashDirective, extractInlineScripts } from '../scripts/cspHashes'
import { ORIGINS_PLACEHOLDER, PAGES, cspProblems, extractCspHeader, isCspViolation, markersInMarkup, postPaths, routeOf, serve, substituteOrigins, uncoveredRoutes } from '../scripts/cspSmoke'

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

  it('оставшийся плейсхолдер и unsafe-inline — по замечанию каждое', () => {
    expect(cspProblems(good.replace(/'sha256[^;]*/, HASH_PLACEHOLDER), html).join('\n')).toContain(HASH_PLACEHOLDER)
    expect(cspProblems(good.replace('script-src \'self\'', 'script-src \'self\' \'unsafe-inline\''), html).join('\n')).toContain('unsafe-inline')
  })

  it('скрипт без хеша — замечание на каждый, с самим хешем', () => {
    const problems = cspProblems('default-src \'self\'; script-src \'self\'', html)
    expect(problems).toHaveLength(extractInlineScripts(html).length)
    for (const problem of problems) expect(problem).toMatch(/'sha256-[A-Za-z0-9+/=]+'/)
  })

  it('нет script-src вовсе — замечание', () => {
    expect(cspProblems('default-src \'self\'', html).join('\n')).toContain('script-src')
  })
})

describe('postPaths', () => {
  // Портал открывает обработчики POST-запросом; без `error_page 405 =200` виджет пуст.
  it('обработчики плейсмента и установки, каталогами', () => {
    expect(postPaths(SERVICE_ROUTES)).toEqual(['/app/', '/install/'])
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
