// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExport } from '~/composables/useExport'
import { buildMockDataset } from '~/utils/mockReport'
import { buildReport } from '~/utils/metrics'

/**
 * Экспорт: книга собирается из листов `reportSheets`, PDF — из снимка элемента; обе ветки
 * отдают файл браузеру ссылкой с blob. Библиотеки подменены: проверяем, ЧТО им передали.
 */
const lib = vi.hoisted(() => ({
  sheets: [] as string[],
  written: undefined as unknown,
  png: { element: undefined as unknown, options: undefined as unknown },
  pdf: { ctor: undefined as unknown, image: undefined as unknown[] | undefined },
  failPng: false
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
    lib.written = { book, options }
    return new Uint8Array([1, 2, 3]).buffer
  }
}))

vi.mock('html-to-image', () => ({
  toPng: async (element: unknown, options: unknown) => {
    if (lib.failPng) throw new Error('снимок не удался')
    lib.png = { element, options }
    return 'data:image/png;base64,AAAA'
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
const downloads: string[] = []

beforeEach(() => {
  lib.sheets = []
  lib.written = undefined
  lib.failPng = false
  downloads.length = 0
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:test', revokeObjectURL: () => {} })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function make() {
  return useExport({ report: ref(report), dataset: ref(dataset), filters: ref({}), isDemo: ref(true) })
}

describe('useExport', () => {
  it('Excel: лист на каждый блок, книга уходит файлом с периодом в имени', async () => {
    const e = make()
    const job = e.exportExcel()
    expect(e.pending.value).toBe('excel')
    await job
    expect(e.pending.value).toBeUndefined()
    expect(e.error.value).toBeUndefined()
    expect(lib.sheets).toEqual(['Сводка', 'Воронка', 'Брак по причинам', 'Причины проигрыша', 'Источники', 'Топ-5 источников', 'Обработка лидов'])
    expect(lib.written).toMatchObject({ options: { bookType: 'xlsx', type: 'array' } })
    expect(downloads).toEqual(['analitika-po-lidam_2026-08-01_2026-08-31.xlsx'])
  })

  it('PDF: снимок элемента целиком, одна страница того же размера', async () => {
    const e = make()
    const element = document.createElement('main')
    Object.defineProperty(element, 'scrollWidth', { value: 1400 })
    Object.defineProperty(element, 'scrollHeight', { value: 3000 })
    await e.exportPdf(element)
    expect(e.error.value).toBeUndefined()
    expect(lib.png.element).toBe(element)
    expect(lib.png.options).toMatchObject({ width: 1400, height: 3000, pixelRatio: 2 })
    expect(lib.pdf.ctor).toMatchObject({ orientation: 'portrait', unit: 'px', format: [1400, 3000] })
    expect(lib.pdf.image?.slice(1)).toEqual(['PNG', 0, 0, 1400, 3000])
    expect(downloads).toEqual(['analitika-po-lidam_2026-08-01_2026-08-31.pdf'])
  })

  it('ошибка снимка — своя, индикатор снят; без элемента — тоже ошибка, не падение', async () => {
    const e = make()
    lib.failPng = true
    await e.exportPdf(document.createElement('main'))
    expect(e.error.value).toContain('снимок не удался')
    expect(e.pending.value).toBeUndefined()
    await e.exportPdf(undefined)
    expect(e.error.value).toContain('не отрисован')
    expect(downloads).toEqual([])
  })

  it('второй экспорт, пока идёт первый, не стартует', async () => {
    const e = make()
    const first = e.exportExcel()
    await e.exportExcel()
    await first
    expect(downloads).toHaveLength(1)
  })
})
