import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright-core'
import { applyHashes, buildHashDirective, htmlFiles } from './cspHashes.ts'

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
 * отсутствие гидрации Vue, отсутствие текста, который рисует ТОЛЬКО JavaScript. Последнее
 * важно: тексты из SSR-разметки есть и у мёртвой страницы — по ним поломку не отличить.
 *
 * Запуск: `pnpm smoke` после `pnpm generate`. Браузер — системный Chrome раннера
 * (`channel: 'chrome'`, без скачивания) либо путь из `CSP_SMOKE_BROWSER`.
 */

/** Плейсхолдер доменов порталов в `nginx.conf`; подставляется при старте контейнера. */
export const ORIGINS_PLACEHOLDER = '${B24_PORTAL_ORIGINS}'

/** Что открыть и какой текст обязан появиться. Пустой список — только «без нарушений и с гидрацией». */
export interface PageCheck {
  path: string
  /** Тексты, которые рисует ТОЛЬКО JavaScript, — их нет в SSR-разметке. */
  mustContain: readonly string[]
}

export const PAGES: readonly PageCheck[] = [
  { path: '/', mustContain: [] },
  // Вне портала `?preview=1` открывает заглушку на клиенте: плашка и панель периодов — только JS.
  { path: '/app/?preview=1', mustContain: ['Это НЕ данные вашего портала', 'Текущий месяц'] },
  // Установщик вне фрейма честно говорит об этом — но говорит это JavaScript, не разметка.
  { path: '/install/', mustContain: ['вне портала Битрикс24'] }
]

/**
 * Значение CSP из `add_header Content-Security-Policy "…"`.
 *
 * Отсутствие директивы — ошибка, а не «проверять нечего»: конфиг без CSP в проде означал бы,
 * что защиту сняли, и смоук, молча прошедший по пустому заголовку, ровно это и скрыл бы.
 */
export function extractCspHeader(conf: string): string {
  const match = /add_header\s+Content-Security-Policy\s+"([^"]*)"/i.exec(conf)
  if (!match?.[1]) throw new Error('В nginx.conf нет add_header Content-Security-Policy')
  return match[1]
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

/** Статика с боевым заголовком на свободном порту. */
async function serve(root: string, csp: string): Promise<{ origin: string, close: () => void }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let file = normalize(join(root, decodeURIComponent(url.pathname)))
    if (!file.startsWith(root)) {
      res.writeHead(403)
      return res.end()
    }
    try {
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

async function checkPage(origin: string, check: PageCheck, browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<PageResult> {
  const problems: string[] = []
  const page = await browser.newPage()
  page.on('console', (message) => {
    if (isCspViolation(message.text())) problems.push(`CSP: ${message.text().slice(0, 160)}`)
  })
  page.on('pageerror', error => problems.push(`ошибка страницы: ${error.message.slice(0, 160)}`))
  try {
    await page.goto(origin + check.path, { waitUntil: 'networkidle', timeout: 45_000 })
    await page.waitForTimeout(1_000)
    // Гидрация. ⚠ Не по атрибуту `data-v-app`: его ставит только `createApp`, а Nuxt гидрирует через
    // `createSSRApp`, который атрибут не ставит вовсе, — проверка по нему падала на живой странице.
    // Надёжный признак — сам Nuxt: `useNuxtApp` в `window` появляется только после старта клиента,
    // а `isHydrating` сбрасывается, когда Vue закончил сверять разметку.
    const hydrated = await page.evaluate(() => {
      const nuxt = (window as unknown as { useNuxtApp?: () => { isHydrating?: boolean } }).useNuxtApp?.()
      return Boolean(nuxt) && nuxt?.isHydrating !== true
    })
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

async function main(): Promise<void> {
  const [dir, configPath] = process.argv.slice(2)
  if (!dir || !configPath) throw new Error('Использование: cspSmoke.ts <каталог статики> <nginx.conf>')

  // Хеши считаем в памяти по собранному HTML — конфиг на диске не трогаем.
  const pages = await Promise.all((await htmlFiles(dir)).map(file => readFile(file, 'utf-8')))
  if (!pages.length) throw new Error(`В ${dir} нет ни одного .html — сборка пуста?`)
  const conf = applyHashes(await readFile(configPath, 'utf-8'), buildHashDirective(pages))
  const csp = substituteOrigins(extractCspHeader(conf), process.env.B24_PORTAL_ORIGINS ?? 'https://*.bitrix24.by')

  const server = await serve(normalize(dir), csp)
  const executablePath = process.env.CSP_SMOKE_BROWSER
  const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' })
  try {
    const results: PageResult[] = []
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
    if (failed) throw new Error(`страниц с проблемами: ${failed} из ${results.length}`)
    console.log(`[smoke] все ${results.length} страницы открылись под боевым CSP без нарушений`)
  } finally {
    await browser.close()
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
