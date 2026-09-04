import type { Ref } from 'vue'
import type { ReportDataset, ReportFilters, ReportMetrics } from '~/types/report'
import { exportFileName, reportSheets } from '~/utils/exportSheets'

/**
 * Экспорт отчёта на клиенте (решение владельца от 2026-09-04, п. 11): Excel — из таблиц, PDF —
 * «текущая страница как есть, любой ценой, без сервера». Backend'а нет и не появится ради этого.
 *
 * ⚠ Библиотеки подгружаются по нажатию (`import()`): книга Excel и генератор PDF — сотни
 * килобайт кода, который не нужен, пока человек смотрит отчёт; в первую загрузку он не попадает,
 * а чанки лежат на своём домене — CSP `script-src 'self'` их пускает.
 *
 * ⚠ `xlsx@0.18.5` — последняя версия SheetJS в npm, дальше только их CDN; известные уязвимости
 * этой версии (CVE-2023-30533, CVE-2024-22363) — в ЧТЕНИИ файлов, а здесь книга только ПИШЕТСЯ
 * из своих метрик, `XLSX.read` не вызывается нигде. Сканеры будут показывать алерт бессрочно —
 * это принятый риск, записан в `docs/METRICS.md`; появится импорт `.xlsx` от пользователя —
 * менять библиотеку.
 *
 * ⚠ PDF — снимок DOM в картинку (`html-to-image`, через SVG `foreignObject` — браузер рисует
 * сам, поэтому цвета Tailwind v4 в `oklch` и шрифты портала переживают снимок; `html2canvas`
 * на `oklch` падает) и одна страница PDF размером с картинку. Красивой вёрстки не будет —
 * владелец на это согласился явно.
 */
export type ExportKind = 'excel' | 'pdf'

/** Предел стороны страницы PDF в CSS-пикселях: у формата PDF потолок 14 400 pt = 19 200 px. */
export const MAX_PDF_PAGE_PX = 19_000
/** Предел стороны холста браузера — дальше `html-to-image` молча ужимает картинку. */
const MAX_CANVAS_SIDE = 16_000
/** Предел площади снимка: 24 мегапикселя — около 100 МБ буферов на главном потоке. */
const MAX_CANVAS_PIXELS = 24e6

/** Масштаб снимка: до двух, но не больше, чем позволяют холст и память. */
export function snapshotRatio(width: number, height: number, devicePixelRatio = 1): number {
  const bySide = MAX_CANVAS_SIDE / Math.max(width, height)
  const byArea = Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
  return Math.max(1, Math.min(2, Math.max(1, devicePixelRatio), bySide, byArea))
}

/**
 * Чанк библиотеки не загрузился (выкатили новую сборку, старые чанки пропали): вместо английского
 * «Failed to fetch dynamically imported module» — по-русски и с выходом. Вынесено наружу, чтобы
 * проверяться без подмены кэша модулей.
 */
export async function loadExportModule<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader()
  } catch {
    throw new Error('Не удалось загрузить модуль экспорта — обновите страницу и попробуйте снова')
  }
}

export function useExport(input: {
  report: Ref<ReportMetrics>
  dataset: Ref<ReportDataset>
  filters: Ref<ReportFilters>
  isDemo: Ref<boolean>
  /** Фоновые выборки ещё идут — файл обязан сказать, чего в нём пока нет. */
  processingPending?: Ref<boolean>
  unlinkedPending?: Ref<boolean>
}) {
  const pending = ref<ExportKind | undefined>(undefined)
  const error = ref<string | undefined>(undefined)
  /** CSS со встроенными шрифтами — считается один раз: иначе каждый PDF заново тянет все subset'ы. */
  let fontCss: string | undefined

  /** Отдать файл браузеру: ссылка с blob и клик — единственный способ скачать без сервера. */
  function download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
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
      const XLSX = await loadExportModule(() => import('xlsx'))
      const book = XLSX.utils.book_new()
      const state = { processingPending: input.processingPending?.value, unlinkedPending: input.unlinkedPending?.value }
      for (const sheet of reportSheets(input.report.value, input.dataset.value, input.filters.value, input.isDemo.value, state)) {
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name)
      }
      const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
      download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), exportFileName(input.dataset.value.period, 'xlsx'))
    })
  }

  /**
   * На время снимка отчёт расширяется до самой широкой таблицы, а их прокрутка снимается (CSS по
   * `data-exporting`): снимок читает ЖИВУЮ вёрстку, и в узком фрейме портала таблица со своей
   * прокруткой попала бы в PDF обрезанной по краю без единого признака этого.
   */
  function widen(element: HTMLElement): () => void {
    const wrappers = Array.from(element.querySelectorAll<HTMLElement>('.overflow-x-auto'))
    const extra = Math.max(0, ...wrappers.map(wrapper => wrapper.scrollWidth - wrapper.clientWidth))
    const previous = { width: element.style.width, maxWidth: element.style.maxWidth }
    element.setAttribute('data-exporting', '')
    if (extra > 0) {
      element.style.maxWidth = 'none'
      element.style.width = `${element.offsetWidth + extra}px`
    }
    return () => {
      element.removeAttribute('data-exporting')
      element.style.width = previous.width
      element.style.maxWidth = previous.maxWidth
    }
  }

  /** Фон страницы под снимок — как на экране, в том числе в тёмной теме; прозрачный — белый. */
  function pageBackground(element: HTMLElement): string {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (color && color !== 'transparent' && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)$/.test(color)) return color
    }
    return '#ffffff'
  }

  /**
   * PDF: снимок элемента (весь дашборд) в JPEG и одна страница PDF того же размера. Одна длинная
   * страница, а не A4 с разрезами: резать таблицу пополам между листами хуже, чем прокрутить.
   * JPEG, а не PNG: PNG `jspdf` перекодирует в JS целиком (десятки мегапикселей на главном
   * потоке), JPEG кладёт как есть; фон и так непрозрачный.
   */
  function exportPdf(element: HTMLElement | null | undefined): Promise<void> {
    return run('pdf', async () => {
      if (!element) throw new Error('Отчёт ещё не отрисован')
      const [{ toJpeg, getFontEmbedCSS }, { jsPDF }] = await Promise.all([loadExportModule(() => import('html-to-image')), loadExportModule(() => import('jspdf'))])
      const restore = widen(element)
      try {
        const width = Math.ceil(element.scrollWidth)
        const height = Math.ceil(element.scrollHeight)
        if (!width || !height) throw new Error('Отчёт ещё не отрисован')
        if (width > MAX_PDF_PAGE_PX || height > MAX_PDF_PAGE_PX) {
          throw new Error('Отчёт слишком длинный для одной страницы PDF — сузьте период или выгрузите Excel')
        }
        fontCss ??= await getFontEmbedCSS(element)
        const image = await toJpeg(element, {
          pixelRatio: snapshotRatio(width, height, window.devicePixelRatio || 1),
          quality: 0.92,
          backgroundColor: pageBackground(element),
          width,
          height,
          fontEmbedCSS: fontCss,
          // Кнопки периода и экспорта в файле не нужны: снимок — про числа, а не про управление.
          filter: node => !(node instanceof HTMLElement && node.hasAttribute('data-export-exclude'))
        })
        const pdf = new jsPDF({ orientation: width >= height ? 'landscape' : 'portrait', unit: 'px', format: [width, height], hotfixes: ['px_scaling'] })
        pdf.addImage(image, 'JPEG', 0, 0, width, height)
        download(pdf.output('blob'), exportFileName(input.dataset.value.period, 'pdf'))
      } finally {
        restore()
      }
    })
  }

  return { pending, error, exportExcel, exportPdf }
}
