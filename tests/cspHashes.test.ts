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
