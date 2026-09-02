import { describe, expect, it } from 'vitest'
import { isPreviewQuery, portalGateState } from '~/utils/inPortalGate'

describe('portalGateState', () => {
  it('до окончания проверки показывает «проверяем», а не заглушку', () => {
    expect(portalGateState({ resolved: false, inPortal: false, preview: false })).toBe('checking')
  })

  it('во фрейме портала показывает интерфейс', () => {
    expect(portalGateState({ resolved: true, inPortal: true, preview: false })).toBe('ok')
  })

  it('снаружи портала показывает объяснение', () => {
    expect(portalGateState({ resolved: true, inPortal: false, preview: false })).toBe('outside')
  })

  // Без обхода не снять скриншоты и не смонтировать страницу в тестах.
  it('preview перекрывает всё, включая незавершённую проверку', () => {
    expect(portalGateState({ resolved: false, inPortal: false, preview: true })).toBe('ok')
  })
})

describe('isPreviewQuery', () => {
  it.each([
    ['?preview=1', '1', true],
    ['?preview=0', '0', false],
    ['голый ?preview', null, false],
    ['отсутствует', undefined, false],
    ['?preview=1&preview=0', ['1', '0'], true],
    ['?preview=0&preview=0', ['0', '0'], false]
  ])('%s', (_name, value, expected) => {
    expect(isPreviewQuery(value)).toBe(expected)
  })
})
