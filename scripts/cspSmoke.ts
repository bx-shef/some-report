import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import { PORTAL_HANDLER_ROUTES, PRERENDER_ROUTES } from '../app/config/routes.ts'
import { HASH_PLACEHOLDER, applyHashes, buildHashDirective, htmlFiles, missingHashes } from './cspHashes.ts'

/**
 * Смоук: открыть собранную страницу НАСТОЯЩИМ браузером под боевым CSP и упасть на первом
 * нарушении.
 *
 * ⚠ Зачем, если есть `cspHashes` и `cspVerify`. Они оба зовут один и тот же разбор HTML, и ошибка
 * в самой классификации скриптов проходит через обоих зелёной. Ровно так в прод уехала
 * заблокированная импорт-карта: хеши на месте, проверка на месте, а приложение не стартовало
 * вообще — сервер отдавал 200, в логах пусто, на экране пред-отрендеренный HTML. Нашли руками,
 * открыв страницу браузером с боевым заголовком. Этот скрипт делает то же самое в CI.
 *
 * Что считается провалом: любое сообщение консоли о нарушении CSP, любая ошибка страницы,
 * не стартовавший Nuxt, отсутствие текста, который рисует ТОЛЬКО JavaScript. Последнее
 * важно: тексты из SSR-разметки есть и у мёртвой страницы — по ним поломку не отличить.
 *
 * Два режима:
 * - `pnpm smoke` — статика из `.output/public` под заголовком, собранным из `nginx.conf` в памяти.
 *   Быстро, без Docker; ловит ошибку классификации скриптов сразу после `pnpm generate`;
 * - `pnpm smoke:image <origin>` — уже поднятый сервер, то есть КОНТЕЙНЕР ИЗ ОБРАЗА. Заголовок
 *   берётся из живого ответа nginx, а не из конфига на диске. Это единственный вариант, который
 *   видит весь путь `Dockerfile` → `envsubst` → `nginx -t` → реальные `add_header` по `location`
 *   и `error_page 405 =200` — то, что локальный сервер лишь имитирует.
 *
 * Что смоук НЕ проверяет: `frame-ancestors` и `connect-src` к REST портала. Страница открывается
 * вне фрейма, SDK не инициализируется — эти директивы срабатывают только внутри портала, и там
 * их по-прежнему проверяют руками после выката (см. `docs/DEPLOY.md`).
 *
 * Браузер — системный Chrome раннера (`channel: 'chrome'`, без скачивания) либо путь из
 * `CSP_SMOKE_BROWSER`.
 */

/** Плейсхолдер доменов порталов в `nginx.conf`; подставляется при старте контейнера. */
export const ORIGINS_PLACEHOLDER = '${B24_PORTAL_ORIGINS}'

/** Что открыть и какой текст обязан появиться. Пустой список — только «без нарушений и со стартом Nuxt». */
export interface PageCheck {
  path: string
  /** Тексты, которые рисует ТОЛЬКО JavaScript, — их нет в SSR-разметке. Это проверяется перед прогоном. */
  mustContain: readonly string[]
}

/**
 * Страницы смоука. Список обязан покрывать `PRERENDER_ROUTES` — это проверяется и тестом, и самим
 * прогоном: новая страница, забытая здесь, уедет в статику непроверенной.
 *
 * Маркеры — литералы из страниц приложения (`app/pages/app/*.vue`), `app/utils/period.ts` и
 * `app/pages/install.vue`. Сменили там текст — обновите здесь: смоук упадёт с «нет текста «…»»,
 * и это не поломка CSP.
 */
export const PAGES: readonly PageCheck[] = [
  { path: '/', mustContain: [] },
  // Главная приложения: список отчётов есть в разметке, а плашку «вне портала» рисует только
  // клиент — после проверки, во фрейме мы или нет.
  { path: '/app/', mustContain: ['Страница открыта вне портала'] },
  // Вне портала `?preview=1` открывает заглушку на клиенте: плашка и панель периодов — только JS.
  { path: '/app/leads/?preview=1', mustContain: ['Это НЕ данные вашего портала', 'Текущий месяц'] },
  // Второй отчёт: демо-плашка, диаграмма «Распределение» и посчитанная матрица — тоже только JS.
  // «Итого по компании» есть только в таблице: заголовок страницы для маркера не годится, он
  // уезжает в SSR-разметку.
  { path: '/app/managers/?preview=1', mustContain: ['Это НЕ данные вашего портала', 'Распределение', 'Итого по компании'] },
  // Установщик вне фрейма честно говорит об этом — но говорит это JavaScript, не разметка.
  { path: '/install/', mustContain: ['вне портала Битрикс24'] }
]

/** Маршрут пререндера для пути смоука: без query и завершающего слэша (`/app/?preview=1` → `/app`). */
export function routeOf(path: string): string {
  const pathname = path.split('?')[0] ?? path
  return pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname
}

/** Маршруты пререндера, для которых нет проверки. Пусто — смоук открывает всё, что уезжает в статику. */
export function uncoveredRoutes(pages: readonly PageCheck[], routes: readonly string[]): string[] {
  const covered = new Set(pages.map(page => routeOf(page.path)))
  return routes.filter(route => !covered.has(routeOf(route)))
}

/**
 * Маркеры страницы, которые ЕСТЬ в SSR-разметке.
 *
 * ⚠ Такой маркер не отличает живую страницу от мёртвой: заголовок «Установка приложения» был на
 * экране и у заблокированной импорт-карты. Стоит кому-то перенести текст плашки в серверный
 * рендер — и смоук по нему снова начнёт проходить на неработающей странице. Поэтому перед
 * прогоном проверяем, что маркеров в собранном HTML нет.
 */
export function markersInMarkup(check: PageCheck, html: string): string[] {
  return check.mustContain.filter(marker => html.includes(marker))
}

/**
 * Что в ответе сервера видно без браузера: заголовок есть, плейсхолдер хешей исчез, в `script-src`
 * нет `'unsafe-inline'`, у каждого инлайнового скрипта страницы есть хеш.
 *
 * ⚠ Браузер всё это тоже поймает — но как «Refused to execute inline script» без указания, ЧТО
 * именно не так. Отсутствие заголовка он не поймает вовсе: страница без CSP открывается лучше
 * всех. Поэтому проверяем явно и называем причину.
 */
export function cspProblems(csp: string | undefined, html: string): string[] {
  if (!csp) return ['нет заголовка Content-Security-Policy — защита снята целиком']
  const problems: string[] = []
  if (csp.includes(HASH_PLACEHOLDER)) problems.push(`в CSP остался плейсхолдер ${HASH_PLACEHOLDER} — браузер заблокирует собственный бандл`)
  const scriptSrc = directiveValue(csp, 'script-src')
  if (scriptSrc === undefined) return [...problems, 'в CSP нет script-src']
  if (scriptSrc.includes('\'unsafe-inline\'')) problems.push('в script-src есть \'unsafe-inline\' — защита от XSS снята')
  for (const { hash, snippet } of missingHashes(html, scriptSrc)) {
    problems.push(`инлайновый скрипт без хеша в script-src: ${hash} — «${snippet}»`)
  }
  return problems
}

/**
 * Значение директивы по точному имени. Не regex по подстроке: `script-src-attr 'none'`, стоящая
 * раньше `script-src`, подошла бы под `/script-src([^;]*)/` и «съела» бы настоящую директиву.
 */
export function directiveValue(csp: string, name: string): string | undefined {
  for (const part of csp.split(';')) {
    const [directive, ...rest] = part.trim().split(/\s+/)
    if (directive === name) return rest.join(' ')
  }
  return undefined
}

/**
 * Origin из аргумента `--origin`. Только http(s): `localhost:8080` без схемы `new URL` принимает,
 * но origin у него «null», и смоук упал бы пятью «Cannot navigate to invalid URL» вместо подсказки.
 */
export function parseOrigin(value: string | undefined): string {
  let url: URL | undefined
  try {
    url = new URL(value ?? '')
  } catch {
    url = undefined
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`«${value ?? ''}» — не адрес сервера; нужен http(s)://host:port`)
  }
  return url.origin
}

/**
 * Пути, которые портал открывает POST-запросом: обработчики плейсмента и установки.
 *
 * ⚠ Статике POST не положен, и nginx по умолчанию отвечает 405 — виджет показывал бы пустоту при
 * исправной сборке. Это лечит `error_page 405 =200 $uri` в `nginx.conf`, и проверить его можно
 * только на настоящем nginx: локальный сервер смоука на метод не смотрит.
 */
export function postPaths(routes: readonly string[]): string[] {
  return routes.map(route => `${routeOf(route)}/`)
}

/**
 * Значение CSP из `add_header Content-Security-Policy "…"`.
 *
 * Отсутствие директивы — ошибка, а не «проверять нечего»: конфиг без CSP в проде означал бы,
 * что защиту сняли, и смоук, молча прошедший по пустому заголовку, ровно это и скрыл бы.
 * Якорь `^\s*` — чтобы закомментированная строка (`# add_header …`) за директиву не сошла:
 * иначе снятая на время отладки защита прошла бы смоук как живая.
 */
export function extractCspHeader(conf: string): string {
  const matches = [...conf.matchAll(/^\s*add_header\s+Content-Security-Policy\s+"([^"]*)"/gim)]
  if (!matches[0]?.[1]) throw new Error('В nginx.conf нет add_header Content-Security-Policy')
  // ⚠ nginx не наследует add_header в location со своими заголовками — второй CSP в другом
  // location был бы отдельной политикой, и смоук, взяв первую, проверил бы не ту. Пока
  // директива одна; появится вторая — сюда придёт автор и решит, какую гонять.
  if (matches.length > 1) throw new Error(`В nginx.conf ${matches.length} директивы Content-Security-Policy — смоук умеет проверять одну`)
  return matches[0][1]
}

/** Домены порталов в заголовке. Для смоука значение не важно: страницу никто не встраивает. */
export function substituteOrigins(csp: string, origins: string): string {
  return csp.replaceAll(ORIGINS_PLACEHOLDER, origins)
}

/** Сообщение консоли — о нарушении CSP? Формулировки Chromium: «Refused to …», «Content Security Policy». */
export function isCspViolation(text: string): boolean {
  return /Refused to|Content Security Policy/i.test(text)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/**
 * Статика с боевым заголовком на свободном порту. `root` — абсолютный путь.
 *
 * Экспортирована ради теста: браузера ей не нужно, а выход за корень и отдача `index.html`
 * каталогу — ровно то, что дешевле поймать тестом, чем ревью.
 */
export async function serve(root: string, csp: string): Promise<{ origin: string, close: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      let file = join(root, pathname)
      // Не выйти за корень: `..` в пути `join` схлопывает, и итог может оказаться выше `root`.
      const inside = relative(root, file)
      if (inside.startsWith('..') || isAbsolute(inside)) {
        res.writeHead(403)
        return res.end()
      }
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('сервер не поднялся')
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

interface PageResult {
  path: string
  problems: string[]
}

async function checkPage(origin: string, check: PageCheck, browser: Browser): Promise<PageResult> {
  const problems: string[] = []
  const page = await browser.newPage()
  page.on('console', (message) => {
    if (isCspViolation(message.text())) problems.push(`CSP: ${message.text().slice(0, 160)}`)
  })
  page.on('pageerror', error => problems.push(`ошибка страницы: ${error.message.slice(0, 160)}`))
  try {
    const response = await page.goto(origin + check.path, { waitUntil: 'networkidle', timeout: 45_000 })
    if (!response) throw new Error('сервер не ответил')
    if (response.status() !== 200) problems.push(`HTTP ${response.status()}`)
    // Заголовок и разметку берём из ответа, а не из конфига или файла: в режиме образа это
    // единственный источник правды, а в локальном — та же проверка, что и в CI.
    const html = await response.text()
    // `allHeaders()`, а не `headers()`: второй по документации Playwright может не отдавать
    // заголовки безопасности — и «нет заголовка CSP» на всех PR было бы ложным.
    problems.push(...cspProblems((await response.allHeaders())['content-security-policy'], html))
    for (const marker of markersInMarkup(check, html)) {
      problems.push(`маркер «${marker}» есть в SSR-разметке — он не отличает живую страницу от мёртвой`)
    }
    // Старт Nuxt. ⚠ Не по атрибуту `data-v-app`: его ставит только `createApp`, а Nuxt гидрирует
    // через `createSSRApp`, который атрибут не ставит вовсе, — проверка по нему падала на живой
    // странице. Надёжный признак — сам Nuxt: `useNuxtApp` в `window` появляется только после
    // старта клиента, а `isHydrating` сбрасывается, когда Vue закончил сверять разметку.
    // Ждём именно этого события, а не таймер: на загруженном раннере фиксированная пауза
    // либо мала (ложный провал), либо велика (медленный шаг).
    const hydrated = await page
      .waitForFunction(() => {
        const nuxt = (window as unknown as { useNuxtApp?: () => { isHydrating?: boolean } }).useNuxtApp?.()
        return Boolean(nuxt) && nuxt?.isHydrating !== true
      }, undefined, { timeout: 15_000 })
      .then(() => true, () => false)
    if (!hydrated) problems.push('Nuxt не стартовал в браузере: JavaScript не выполнился')
    const text = await page.evaluate(() => document.body.innerText)
    for (const expected of check.mustContain) {
      if (!text.includes(expected)) problems.push(`нет текста «${expected}» — его рисует только JavaScript`)
    }
  } catch (error) {
    problems.push(`не открылась: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
  } finally {
    await page.close()
  }
  return { path: check.path, problems }
}

/**
 * POST на обработчик — ответ 200, та же страница, что по GET, и тот же CSP.
 *
 * Без браузера, через `fetch`: это проверка nginx, а не страницы, и не должна зависеть от того,
 * нашёлся ли Chrome. Заголовок проверяем и здесь: именно этот ответ портал и рисует, а
 * `error_page` с именованной локацией мог бы отдать его без серверных `add_header`.
 */
async function checkPost(origin: string, path: string): Promise<PageResult> {
  const problems: string[] = []
  try {
    const response = await fetch(origin + path, { method: 'POST', signal: AbortSignal.timeout(15_000) })
    const body = await response.text()
    if (response.status !== 200) problems.push(`HTTP ${response.status} — портал открывает обработчик POST-запросом и увидит пустоту`)
    else if (!body.includes('id="__nuxt"')) problems.push('в ответе нет разметки приложения')
    problems.push(...cspProblems(response.headers.get('content-security-policy') ?? undefined, body))
  } catch (error) {
    problems.push(`запрос не прошёл: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
  }
  return { path: `POST ${path}`, problems }
}

const USAGE = `Использование:
  cspSmoke.ts <каталог статики> <nginx.conf>   локальный сервер с заголовком из конфига
  cspSmoke.ts --origin <URL>                   уже поднятый сервер (контейнер из образа)`

/** Локальный сервер: заголовок собирается из `nginx.conf` в памяти, конфиг на диске не трогаем. */
async function serveBuild(dir: string, configPath: string): Promise<{ origin: string, close: () => void }> {
  const root = resolve(dir)
  const pages = await Promise.all((await htmlFiles(root)).map(file => readFile(file, 'utf-8')))
  if (!pages.length) throw new Error(`В ${dir} нет ни одного .html — сборка пуста?`)
  const conf = applyHashes(await readFile(configPath, 'utf-8'), buildHashDirective(pages))
  const csp = substituteOrigins(extractCspHeader(conf), process.env.B24_PORTAL_ORIGINS ?? 'https://*.bitrix24.by')
  return serve(root, csp)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const uncovered = uncoveredRoutes(PAGES, PRERENDER_ROUTES)
  if (uncovered.length) throw new Error(`маршруты пререндера без проверки: ${uncovered.join(', ')} — добавьте их в PAGES`)

  const imageMode = args[0] === '--origin'
  let server: { origin: string, close: () => void }
  if (imageMode) {
    server = { origin: parseOrigin(args[1]), close: () => {} }
  } else {
    const [dir, configPath] = args
    if (!dir || !configPath) throw new Error(USAGE)
    server = await serveBuild(dir, configPath)
  }

  // POST — только на образе: локальный сервер на метод не смотрит, и зелёная галочка там ничего
  // не значила бы. Идёт до браузера: nginx проверяется и тогда, когда Chrome не нашёлся.
  const results: PageResult[] = []
  if (imageMode) {
    for (const path of postPaths(PORTAL_HANDLER_ROUTES)) results.push(await checkPost(server.origin, path))
  } else {
    console.log('[smoke] POST на обработчики: пропущено — проверяется только на образе (pnpm smoke:image)')
  }

  // Браузер подключаем только здесь: тесты импортируют чистые функции выше и тянуть playwright не должны.
  const { chromium } = await import('playwright-core')
  const executablePath = process.env.CSP_SMOKE_BROWSER
  // Запуск браузера — внутри try: не нашёлся Chrome — сервер всё равно надо погасить.
  let browser: Browser | undefined
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' })
    for (const check of PAGES) results.push(await checkPage(server.origin, check, browser))
    let failed = 0
    for (const { path, problems } of results) {
      if (problems.length) {
        failed++
        console.error(`[smoke] ✕ ${path}`)
        for (const problem of problems) console.error(`         ${problem}`)
      } else {
        console.log(`[smoke] ✓ ${path}`)
      }
    }
    if (failed) throw new Error(`проверок с проблемами: ${failed} из ${results.length}`)
    console.log(`[smoke] ${server.origin}: все ${results.length} проверки прошли под боевым CSP без нарушений`)
  } finally {
    await browser?.close()
    server.close()
  }
}

// Запуск только как CLI: при импорте из теста main() не должен ничего поднимать.
if (process.argv[1]?.endsWith('cspSmoke.ts')) {
  main().catch((error) => {
    console.error(`[smoke] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
