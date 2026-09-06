import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HASH_PLACEHOLDER,
  applyHashes,
  buildHashDirective,
  extractInlineScripts,
  scriptHash
} from '../scripts/cspHashes'

describe('extractInlineScripts', () => {
  it('берёт тело встроенного скрипта', () => {
    expect(extractInlineScripts('<script>window.a=1</script>')).toEqual(['window.a=1'])
  })

  // Внешний скрипт разрешает `script-src 'self'`, тела у него нет — хешировать нечего.
  it('внешний скрипт пропускает', () => {
    expect(extractInlineScripts('<script src="/_nuxt/app.js"></script>')).toEqual([])
  })

  it('модуль считается исполняемым', () => {
    expect(extractInlineScripts('<script type="module">import "x"</script>')).toEqual(['import "x"'])
  })

  // Блок данных браузер не исполняет, CSP его не проверяет: хеш для него раздувал бы заголовок
  // и создавал ложное впечатление, что он что-то разрешает.
  it.each([
    ['application/ld+json', '{"@type":"X"}'],
    ['application/json', '{"a":1}'],
    ['text/template', '<div></div>']
  ])('блок данных %s пропускает', (type, body) => {
    expect(extractInlineScripts(`<script type="${type}">${body}</script>`)).toEqual([])
  })

  it('пустой скрипт пропускает', () => {
    expect(extractInlineScripts('<script>   </script>')).toEqual([])
  })

  it('находит несколько скриптов на странице', () => {
    const html = '<script>a</script><p>текст</p><script type="text/javascript">b</script>'
    expect(extractInlineScripts(html)).toEqual(['a', 'b'])
  })

  // ⚠ Этот тест оплачен простоем в проде. Импорт-карту браузер ИСПОЛНЯЕТ и CSP её ПРОВЕРЯЕТ,
  // а прошлый разбор считал исполняемыми только знакомые JS-типы и молча её выбрасывал. Без
  // хеша браузер блокировал карту, специфик `#entry` переставал разрешаться, и приложение не
  // стартовало ВООБЩЕ: сервер отдавал 200, в логах пусто, на экране пред-отрендеренный HTML.
  it('импорт-карту хеширует — её CSP проверяет', () => {
    const html = '<script type="importmap">{"imports":{"#entry":"/_nuxt/a.js"}}</script>'
    expect(extractInlineScripts(html)).toEqual(['{"imports":{"#entry":"/_nuxt/a.js"}}'])
  })

  // Правило теперь «всё, кроме известных блоков данных». Незнакомый тип обязан попасть в хеши:
  // лишний хеш в заголовке безвреден, пропущенный — это мёртвое приложение.
  it('незнакомый тип хеширует, а не выбрасывает', () => {
    expect(extractInlineScripts('<script type="speculationrules">{}</script>')).toEqual(['{}'])
  })
})

describe('настоящая страница, собранная Nuxt', () => {
  // Фикстура снята с боевой сборки. Синтетические примеры этот дефект не ловили: они содержали
  // ровно те теги, о которых автор уже подумал. Реальная страница содержит те, о которых он НЕ
  // подумал, — поэтому фикстура и лежит в репозитории.
  const html = readFileSync(join(import.meta.dirname, 'fixtures/nuxtPage.html'), 'utf-8')

  it('содержит импорт-карту, внешний модуль и блок данных — иначе фикстура устарела', () => {
    expect(html).toContain('<script type="importmap">')
    expect(html).toMatch(/<script type="module" src="[^"]+"/)
    expect(html).toContain('id="__NUXT_DATA__"')
  })

  it('хеширует и импорт-карту, и конфиг Nuxt, и ничего больше', () => {
    const scripts = extractInlineScripts(html)
    expect(scripts).toHaveLength(2)
    expect(scripts.some(s => s.includes('"#entry"'))).toBe(true)
    expect(scripts.some(s => s.includes('window.__NUXT__'))).toBe(true)
  })

  // Блок `__NUXT_DATA__` свой на каждой странице: попади он в хеши, заголовок рос бы с каждой
  // новой страницей приложения. Браузер его не исполняет — проверено на боевом заголовке.
  it('блок данных страницы не хеширует', () => {
    expect(extractInlineScripts(html).some(s => s.includes('"serverRendered"'))).toBe(false)
  })
})

describe('scriptHash', () => {
  it('даёт источник в формате CSP', () => {
    expect(scriptHash('')).toBe('\'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\'')
  })

  // Хеш обязан меняться от содержимого — иначе он ничего не разрешает адресно.
  it('разное содержимое даёт разные хеши', () => {
    expect(scriptHash('a')).not.toBe(scriptHash('b'))
  })
})

describe('buildHashDirective', () => {
  it('схлопывает одинаковые скрипты с разных страниц', () => {
    const directive = buildHashDirective(['<script>same</script>', '<script>same</script>'])
    expect(directive.split(' ')).toHaveLength(1)
  })

  // Нестабильный порядок менял бы nginx.conf на каждой сборке и мешал читать дифф.
  it('порядок стабильный независимо от порядка страниц', () => {
    const pages = ['<script>a</script>', '<script>b</script>']
    expect(buildHashDirective(pages)).toBe(buildHashDirective([...pages].reverse()))
  })

  it('без встроенных скриптов даёт пустую строку', () => {
    expect(buildHashDirective(['<script src="/x.js"></script>'])).toBe('')
  })
})

describe('applyHashes', () => {
  it('подставляет хеши на место плейсхолдера', () => {
    expect(applyHashes(`script-src 'self' ${HASH_PLACEHOLDER};`, '\'sha256-x\''))
      .toBe('script-src \'self\' \'sha256-x\';')
  })

  /**
   * ⚠ Молчаливый пропуск оставил бы в проде CSP, которая блокирует собственные скрипты
   * приложения, — белый экран без единой строки в логе сервера. Лучше уронить сборку.
   */
  it('без плейсхолдера бросает исключение, а не молчит', () => {
    expect(() => applyHashes('script-src \'self\';', '\'sha256-x\'')).toThrow(HASH_PLACEHOLDER)
  })
})
