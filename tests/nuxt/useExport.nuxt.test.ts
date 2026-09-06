// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PDF_PAGE_PX, loadExportModule, snapshotRatio, useExport } from '~/composables/useExport'
import { buildMockDataset } from '~/utils/mockReport'
import { buildReport } from '~/utils/metrics'

/**
 * Экспорт: книга собирается из листов `reportSheets`, PDF — из снимка элемента; обе ветки
 * отдают файл браузеру ссылкой с blob. Библиотеки подменены: проверяем, ЧТО им передали.
 */
const lib = vi.hoisted(() => ({
  sheets: [] as string[],
  written: undefined as unknown,
  snapshot: { element: undefined as unknown, options: undefined as { width?: number, height?: number, pixelRatio?: number, quality?: number, backgroundColor?: string, filter?: (node: HTMLElement) => boolean, fontEmbedCSS?: string } | undefined },
  fontCalls: 0,
  pdf: { ctor: undefined as unknown, image: undefined as unknown[] | undefined },
  failSnapshot: false,
  failWrite: false
}))

vi.mock('xlsx', () => ({
  utils: {
    book_new: () => ({ sheets: [] as string[] }),
    aoa_to_sheet: (rows: unknown[][]) => ({ rows }),
    book_append_sheet: (book: { sheets: string[] }, _sheet: unknown, name: string) => {
      book.sheets.push(name)
      lib.sheets = book.sheets
    }
  },
  write: (book: unknown, options: unknown) => {
    if (lib.failWrite) throw new Error('книга не собралась')
    lib.written = { book, options }
    return new Uint8Array([1, 2, 3]).buffer
  }
}))

vi.mock('html-to-image', () => ({
  toJpeg: async (element: unknown, options: unknown) => {
    if (lib.failSnapshot) throw new Error('снимок не удался')
    lib.snapshot = { element, options: options as typeof lib.snapshot.options }
    return 'data:image/jpeg;base64,AAAA'
  },
  getFontEmbedCSS: async () => {
    lib.fontCalls++
    return '@font-face {}'
  }
}))

vi.mock('jspdf', () => ({
  jsPDF: class {
    constructor(options: unknown) { lib.pdf.ctor = options }
    addImage(...args: unknown[]) { lib.pdf.image = args }
    output() { return new Blob(['pdf']) }
  }
}))

const dataset = buildMockDataset()
const report = buildReport(dataset.leads, dataset.deals, { conversionBase: 'quality-leads', firstResponseSlaMinutes: 120 })
const downloads: Array<{ name: string, href: string }> = []
const revoked: string[] = []

beforeEach(() => {
  lib.sheets = []
  lib.written = undefined
  lib.failSnapshot = false
  lib.failWrite = false
  lib.fontCalls = 0
  downloads.length = 0
  revoked.length = 0
  // Конструктор URL остаётся настоящим: подменяем только фабрику blob-ссылок.
  vi.stubGlobal('URL', Object.assign(class extends URL {}, {
    createObjectURL: () => 'blob:test',
    revokeObjectURL: (url: string) => {
      revoked.push(url)
    }
  }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function make(extra: Partial<Parameters<typeof useExport>[0]> = {}) {
  return useExport({ report: ref(report), dataset: ref(dataset), filters: ref({}), isDemo: ref(true), ...extra })
}

function sized(width: number, height: number): HTMLElement {
  const element = document.createElement('main')
  Object.defineProperty(element, 'scrollWidth', { value: width, configurable: true })
  Object.defineProperty(element, 'scrollHeight', { value: height, configurable: true })
  Object.defineProperty(element, 'offsetWidth', { value: width, configurable: true })
  document.body.appendChild(element)
  return element
}

describe('useExport', () => {
  it('Excel: лист на каждый блок, книга уходит файлом с периодом в имени, blob освобождается позже', async () => {
    vi.useFakeTimers()
    const e = make()
    const job = e.exportExcel()
    expect(e.pending.value).toBe('excel')
    await job
    expect(e.pending.value).toBeUndefined()
    expect(e.error.value).toBeUndefined()
    expect(lib.sheets).toEqual(['Сводка', 'Воронка', 'Брак по причинам', 'Причины проигрыша', 'Источники', 'Топ-5 источников', 'Обработка лидов'])
    expect(lib.written).toMatchObject({ options: { bookType: 'xlsx', type: 'array' } })
    expect(downloads).toEqual([{ name: 'analitika-po-lidam_2026-08-01_2026-08-31.xlsx', href: 'blob:test' }])
    expect(document.body.querySelector('a[download]')).toBeNull()
    expect(revoked).toEqual([])
    vi.advanceTimersByTime(10_000)
    expect(revoked).toEqual(['blob:test'])
  })

  it('PDF: снимок элемента целиком в JPEG, одна страница того же размера, кнопки исключены, шрифты один раз', async () => {
    const e = make()
    const element = sized(1400, 3000)
    await e.exportPdf(element)
    expect(e.error.value).toBeUndefined()
    expect(lib.snapshot.element).toBe(element)
    expect(lib.snapshot.options).toMatchObject({ width: 1400, height: 3000, quality: 0.92, fontEmbedCSS: '@font-face {}' })
    expect(lib.snapshot.options?.pixelRatio).toBe(snapshotRatio(1400, 3000, window.devicePixelRatio || 1))
    const excluded = document.createElement('button')
    excluded.setAttribute('data-export-exclude', '')
    expect(lib.snapshot.options?.filter?.(excluded)).toBe(false)
    expect(lib.snapshot.options?.filter?.(document.createElement('div'))).toBe(true)
    expect(lib.pdf.ctor).toMatchObject({ orientation: 'portrait', unit: 'px', format: [1400, 3000] })
    expect(lib.pdf.image?.slice(1)).toEqual(['JPEG', 0, 0, 1400, 3000])
    expect(downloads.map(d => d.name)).toEqual(['analitika-po-lidam_2026-08-01_2026-08-31.pdf'])
    // Атрибут снимка снят, стили возвращены.
    expect(element.hasAttribute('data-exporting')).toBe(false)
    await e.exportPdf(element)
    expect(lib.fontCalls).toBe(1)
  })

  it('ошибки — свои и по-русски: снимок, книга, элемент без размеров, чанк библиотеки; индикатор снят', async () => {
    const e = make()
    lib.failSnapshot = true
    await e.exportPdf(sized(100, 100))
    expect(e.error.value).toContain('снимок не удался')
    expect(e.pending.value).toBeUndefined()
    lib.failSnapshot = false

    lib.failWrite = true
    await e.exportExcel()
    expect(e.error.value).toContain('книга не собралась')
    lib.failWrite = false

    await e.exportPdf(undefined)
    expect(e.error.value).toContain('не отрисован')
    await e.exportPdf(document.createElement('main'))
    expect(e.error.value).toContain('не отрисован')

    // Чанк библиотеки не загрузился (старая сборка после выката) — по-русски, с выходом.
    await expect(loadExportModule(() => Promise.reject(new Error('Failed to fetch dynamically imported module')))).rejects.toThrow('обновите страницу')
    expect(downloads).toEqual([])
  })

  // У формата PDF потолок 14 400 pt на сторону — годовой отчёт с длинной страницей в него не влезет.
  it('слишком длинная страница — понятная ошибка, а не невалидный PDF', async () => {
    const e = make()
    await e.exportPdf(sized(1400, MAX_PDF_PAGE_PX + 1))
    expect(e.error.value).toContain('слишком длинный')
    expect(downloads).toEqual([])
  })

  it('масштаб снимка: до двух, но не больше, чем позволяют холст и память', () => {
    expect(snapshotRatio(1400, 3000, 2)).toBe(2)
    expect(snapshotRatio(1400, 3000, 1)).toBe(1)
    expect(snapshotRatio(1400, 9000, 2)).toBeLessThan(2)
    // ⚠ Длинный дашборд: холст и при масштабе 1 больше предела стороны, поэтому масштаб обязан
    // упасть НИЖЕ единицы. Внешний `Math.max(1, …)` делал пределы недостижимыми, и вкладка
    // упиралась бы в память браузера при исправном на вид коде.
    expect(snapshotRatio(1400, 18000, 1)).toBeLessThan(1)
    expect(snapshotRatio(1400, 9000, 2)).toBeGreaterThanOrEqual(1)
    // Тот же длинный дашборд на экране с плотностью 2: пределы холста режут масштаб одинаково —
    // ниже единицы, а не «не ниже единицы». Лучше чуть более грубый снимок, чем пустой файл.
    expect(snapshotRatio(1400, 18_000, 2)).toBeCloseTo(16_000 / 18_000)
  })

  it('второй экспорт, пока идёт первый, не стартует', async () => {
    const e = make()
    const first = e.exportExcel()
    await e.exportExcel()
    await first
    expect(downloads).toHaveLength(1)
  })
})
