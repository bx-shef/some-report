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

  // ⚠ Без фильтра энтрипойнт подставляет в шаблон ВСЕ переменные окружения, а конфиг полон
  // собственных `$uri` и `$host`: совпадение имён молча сломало бы конфиг.
  // ⚠ Ищем ДИРЕКТИВУ в начале строки, а не подстроку: закомментированная `# ENV …` содержит тот же
  // текст, а рантайм-подстановка при этом сломана — и подставлялись бы ВСЕ переменные окружения.
  it('ограничивает подстановку одной переменной, с якорями', () => {
    expect(dockerfile).toMatch(/^ENV NGINX_ENVSUBST_FILTER="\^B24_PORTAL_ORIGINS\$"$/m)
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
