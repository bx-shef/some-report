import type { Ref } from 'vue'
import type { ReportDataset, ReportFilters, ReportMetrics } from '~/types/report'
import { exportFileName, reportSheets } from '~/utils/exportSheets'

/**
 * Экспорт отчёта на клиенте (решение владельца от 2026-09-04, п. 11): Excel — из таблиц, PDF —
 * «текущая страница как есть, любой ценой, без сервера». Backend'а нет и не появится ради этого.
 *
 * ⚠ Библиотеки подгружаются по нажатию (`import()`): книга Excel и генератор PDF — под мегабайт
 * кода, который не нужен, пока человек смотрит отчёт; в первую загрузку он не попадает, а чанки
 * лежат на своём домене — CSP `script-src 'self'` их пускает.
 *
 * ⚠ PDF — снимок DOM в картинку (`html-to-image`, через SVG `foreignObject` — браузер рисует
 * сам, поэтому цвета Tailwind v4 в `oklch` и шрифты портала переживают снимок; `html2canvas`
 * на `oklch` падает) и одна страница PDF размером с картинку. Красивой вёрстки не будет —
 * владелец на это согласился явно.
 */
export type ExportKind = 'excel' | 'pdf'

export function useExport(input: { report: Ref<ReportMetrics>, dataset: Ref<ReportDataset>, filters: Ref<ReportFilters>, isDemo: Ref<boolean> }) {
  const pending = ref<ExportKind | undefined>(undefined)
  const error = ref<string | undefined>(undefined)

  /** Отдать файл браузеру: ссылка с blob и клик — единственный способ скачать без сервера. */
  function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    // Ссылку на blob освобождаем позже: браузер читает её после клика асинхронно.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  async function run(kind: ExportKind, job: () => Promise<void>): Promise<void> {
    // Второй экспорт, пока идёт первый, — тот же файл дважды; ждём.
    if (pending.value) return
    pending.value = kind
    error.value = undefined
    try {
      await job()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      pending.value = undefined
    }
  }

  /** Книга Excel: лист на каждый блок отчёта, числа — те же, что на экране (`reportSheets`). */
  function exportExcel(): Promise<void> {
    return run('excel', async () => {
      const XLSX = await import('xlsx')
      const book = XLSX.utils.book_new()
      for (const sheet of reportSheets(input.report.value, input.dataset.value, input.filters.value, input.isDemo.value)) {
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name)
      }
      const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
      download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), exportFileName(input.dataset.value.period, 'xlsx'))
    })
  }

  /**
   * PDF: снимок элемента (весь дашборд) в PNG и одна страница PDF того же размера. Одна длинная
   * страница, а не A4 с разрезами: резать таблицу пополам между листами хуже, чем прокрутить.
   */
  function exportPdf(element: HTMLElement | null | undefined): Promise<void> {
    return run('pdf', async () => {
      if (!element) throw new Error('Отчёт ещё не отрисован')
      const [{ toPng }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')])
      const width = Math.ceil(element.scrollWidth)
      const height = Math.ceil(element.scrollHeight)
      const image = await toPng(element, { pixelRatio: 2, backgroundColor: '#ffffff', width, height })
      const pdf = new jsPDF({ orientation: width >= height ? 'landscape' : 'portrait', unit: 'px', format: [width, height], hotfixes: ['px_scaling'] })
      pdf.addImage(image, 'PNG', 0, 0, width, height)
      download(pdf.output('blob'), exportFileName(input.dataset.value.period, 'pdf'))
    })
  }

  return { pending, error, exportExcel, exportPdf }
}
