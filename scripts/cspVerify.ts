import { readFile } from 'node:fs/promises'
import { extractInlineScripts, htmlFiles, missingHashes } from './cspHashes.ts'

/**
 * Проверка, что собранный `nginx.conf` разрешает КАЖДЫЙ инлайновый скрипт КАЖДОЙ собранной
 * страницы.
 *
 * ⚠ Зачем отдельный шаг, если хеши только что подставил `cspHashes.ts`. Затем, что подстановка и
 * проверка отвечают на разные вопросы. Подстановка отвечает «мы записали то, что насчитали»;
 * проверка — «в конфиге есть хеш для каждого скрипта, который браузер попытается исполнить».
 * Между ними помещаются: сломанный плейсхолдер, перезапись конфига следующим шагом сборки,
 * страница, появившаяся после расчёта хешей.
 *
 * Дефект, ради которого шаг заведён: `<script type="importmap">` выпадал из разбора, хеша для
 * него не считалось, браузер блокировал карту — и приложение не стартовало ВООБЩЕ. Сервер при
 * этом отдавал 200, в его логах не было ни строки, а на экране оставался пред-отрендеренный
 * HTML. Со стороны это выглядело как «зависло».
 *
 * ⚠ Чего этот шаг НЕ ловит: ошибку в самой классификации скриптов (он зовёт тот же
 * `extractInlineScripts`). Её сторожат тесты на настоящей странице Nuxt в
 * `tests/cspHashes.test.ts`, а окончательно — `scripts/cspSmoke.ts`: загрузка страницы
 * браузером с боевым заголовком, отдельным шагом CI.
 */
async function main(): Promise<void> {
  const [dir, configPath] = process.argv.slice(2)
  if (!dir || !configPath) {
    throw new Error('Использование: cspVerify.ts <каталог статики> <путь к nginx.conf>')
  }

  const config = await readFile(configPath, 'utf-8')
  const files = await htmlFiles(dir)
  if (!files.length) throw new Error(`В ${dir} нет ни одного .html — сборка пуста?`)

  const missing: string[] = []
  let checked = 0
  for (const file of files) {
    const html = await readFile(file, 'utf-8')
    checked += extractInlineScripts(html).length
    for (const { snippet } of missingHashes(html, config)) missing.push(`${file}: ${snippet}`)
  }

  if (missing.length) {
    throw new Error(`в CSP нет хеша для ${missing.length} скрипт(ов):\n  ${missing.join('\n  ')}`)
  }
  console.log(`[csp] проверено скриптов: ${checked} на ${files.length} страницах — все покрыты хешами`)
}

main().catch((error) => {
  console.error(`[csp] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
