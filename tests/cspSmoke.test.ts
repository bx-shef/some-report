import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ORIGINS_PLACEHOLDER, PAGES, extractCspHeader, isCspViolation, substituteOrigins } from '../scripts/cspSmoke'

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

describe('страницы смоука', () => {
  it('проверяет все три страницы приложения', () => {
    expect(PAGES.map(p => p.path)).toEqual(['/', '/app/?preview=1', '/install/'])
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
