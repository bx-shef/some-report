import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Подстановка sha256-хешей встроенных скриптов в CSP.
 *
 * Зачем вообще: Nuxt печатает в HTML пару инлайновых `<script>` (в том числе
 * `window.__NUXT__.config`, чей текст меняется от сборки к сборке). Разрешить их можно двумя
 * способами — `script-src 'unsafe-inline'` либо перечислить их хеши. Первый способ снимает защиту
 * от XSS ЦЕЛИКОМ: браузер перестаёт отличать наш скрипт от вставленного через дыру. Поэтому
 * считаем хеши на сборке и подставляем их в `nginx.conf` вместо плейсхолдера.
 *
 * ⚠ Хеши обязаны считаться по СОБРАННОМУ HTML, а не по исходникам: `buildId` внутри
 * `window.__NUXT__.config` новый на каждую сборку, и хеш, посчитанный заранее, не совпал бы.
 */

/** Плейсхолдер в `nginx.conf`, на место которого подставляются хеши. */
export const HASH_PLACEHOLDER = '__CSP_SCRIPT_HASHES__'

/**
 * Тела встроенных скриптов из HTML.
 *
 * Берём только исполняемые: `<script>` без `type` либо с JS-типом. Блоки данных
 * (`application/ld+json` и прочие) браузер не исполняет, CSP их не проверяет — а посчитанный
 * для них хеш просто раздувал бы заголовок и создавал ложное впечатление, что он что-то
 * разрешает.
 */
export function extractInlineScripts(html: string): string[] {
  const found: string[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] ?? ''
    const body = match[2] ?? ''
    // Внешний скрипт: у него нет тела, разрешает его `script-src 'self'`.
    if (/\ssrc\s*=/i.test(attrs)) continue
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase()
    const executable = !type
      || type === 'module'
      || type === 'text/javascript'
      || type === 'application/javascript'
    if (!executable) continue
    if (!body.trim()) continue
    found.push(body)
  }
  return found
}

/** Источник директивы CSP для одного скрипта: `'sha256-<base64>'`. */
export function scriptHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`
}

/**
 * Готовая строка источников для `script-src` по набору HTML-страниц.
 *
 * Дубликаты схлопываются (тема-инициализация одна и та же на всех страницах), порядок
 * стабильный — иначе `nginx.conf` менялся бы на каждой сборке без смысла и мешал бы читать дифф.
 */
export function buildHashDirective(htmlPages: string[]): string {
  const hashes = new Set<string>()
  for (const html of htmlPages) {
    for (const source of extractInlineScripts(html)) hashes.add(scriptHash(source))
  }
  return [...hashes].sort().join(' ')
}

/**
 * Подставить хеши в конфиг.
 *
 * ⚠ Отсутствие плейсхолдера — ОШИБКА, а не «нечего делать»: значит конфиг переписали и CSP
 * поехала. Молчаливый пропуск оставил бы в проде заголовок, который блокирует собственные
 * скрипты приложения, — белый экран без единой строки в логе сервера.
 */
export function applyHashes(config: string, directive: string): string {
  if (!config.includes(HASH_PLACEHOLDER)) {
    throw new Error(`В конфиге нет плейсхолдера ${HASH_PLACEHOLDER} — CSP не соберётся`)
  }
  return config.replaceAll(HASH_PLACEHOLDER, directive)
}

/** Рекурсивно собрать пути всех `.html` в каталоге. */
async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await htmlFiles(path))
    else if (entry.name.endsWith('.html')) files.push(path)
  }
  return files
}

/** CLI: `node --experimental-strip-types scripts/cspHashes.ts <каталог-статики> <nginx.conf>` */
async function main(): Promise<void> {
  const [dir, configPath] = process.argv.slice(2)
  if (!dir || !configPath) {
    throw new Error('Использование: cspHashes.ts <каталог статики> <путь к nginx.conf>')
  }
  const pages = await Promise.all((await htmlFiles(dir)).map(f => readFile(f, 'utf-8')))
  if (!pages.length) throw new Error(`В ${dir} нет ни одного .html — сборка пуста?`)

  const directive = buildHashDirective(pages)
  // Пустой набор хешей — тоже ошибка: значит разбор HTML сломался, а не «инлайновых скриптов нет».
  // Nuxt всегда печатает как минимум `window.__NUXT__`, и тихо выехавшая отсюда пустота дала бы
  // CSP, блокирующую собственный бандл.
  if (!directive) throw new Error('Не найдено ни одного встроенного скрипта — разбор HTML сломан')

  await writeFile(configPath, applyHashes(await readFile(configPath, 'utf-8'), directive), 'utf-8')
  console.log(`[csp] подставлено хешей: ${directive.split(' ').length}`)
}

// Запуск только как CLI: при импорте из теста main() не должен трогать файлы.
if (process.argv[1]?.endsWith('cspHashes.ts')) {
  main().catch((error) => {
    console.error(`[csp] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
