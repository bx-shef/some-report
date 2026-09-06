import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_NAME_FULL, APP_REPORTS } from '~/config/routes'
import { pageTitle, reportTitle } from '~/utils/pageTitle'

/**
 * Как приложение называет СЕБЯ и свои отчёты. Проверяем ровно тот дефект, который здесь уже был
 * и прожил два отчёта:
 * хвост заголовка был именем ПЕРВОГО отчёта, и вкладка отчёта 3 читалась «Активность
 * пользователей — Аналитика по лидам».
 *
 * ⚠ Внутри портала это невидимо в принципе: отчёт открыт во фрейме, заголовок вкладки там
 * принадлежит порталу. Поэтому проверять склейку может только тест — глазами её не встретишь.
 */

describe('заголовок вкладки', () => {
  it('к имени страницы добавляет имя ПРИЛОЖЕНИЯ, а не имя отчёта', () => {
    expect(pageTitle('Установка')).toBe(`Установка — ${APP_NAME}`)
    // Имя любого отчёта в хвосте — это и есть тот дефект. Ни одно из трёх там стоять не должно.
    for (const report of APP_REPORTS) {
      expect(pageTitle('Установка')).not.toContain(report.title)
    }
  })

  it('без имени страницы отдаёт полное имя приложения', () => {
    expect(pageTitle()).toBe(APP_NAME_FULL)
    expect(pageTitle(undefined)).toBe(APP_NAME_FULL)
    // Пустая строка приходит от страницы, забывшей заголовок: «— Отчёты по CRM» с висящим тире
    // хуже, чем просто имя приложения.
    expect(pageTitle('')).toBe(APP_NAME_FULL)
    expect(pageTitle('   ')).toBe(APP_NAME_FULL)
  })

  it('полное имя содержит короткое — это одно имя, а не два разных', () => {
    expect(APP_NAME_FULL.startsWith(APP_NAME)).toBe(true)
    expect(APP_NAME_FULL).not.toBe(APP_NAME)
  })
})

describe('имя отчёта во вкладке', () => {
  // ⚠ Вкладка и пункт меню CRM-аналитики обязаны называть отчёт ОДИНАКОВО: у отчёта 1 вкладка
  // говорила «Отчёт», и это читалось нормально ровно пока отчёт был один. Человек с тремя
  // открытыми вкладками различает их только по этой строке.
  it('совпадает с названием отчёта из списка маршрутов', () => {
    for (const report of APP_REPORTS) {
      expect(reportTitle(report.path)).toBe(report.title)
    }
  })

  it('каждый отчёт получает СВОЁ имя, а не одно на всех', () => {
    const titles = APP_REPORTS.map(report => reportTitle(report.path))
    expect(new Set(titles).size).toBe(APP_REPORTS.length)
    expect(titles.every(title => title.trim() !== '')).toBe(true)
  })

  // Тип не даёт передать чужой путь, но падать здесь всё равно нельзя: заголовок вкладки — не
  // повод не показать отчёт.
  it('на неизвестный путь отвечает именем приложения, а не падает', () => {
    expect(reportTitle('/app/nosuch' as (typeof APP_REPORTS)[number]['path'])).toBe(APP_NAME)
  })
})

/**
 * Гард по ИСХОДНИКУ страниц — как `palette.test.ts` сторожит `main.css`.
 *
 * Проверять склейку мало: обе прежние ошибки жили не в функции, а в том, ЧТО страница ей
 * передавала — литерал «Отчёт» на отчёте 1 и имя первого отчёта в хвосте на всех сразу.
 * Литерал возвращается одной строкой, и заметить его внутри портала нельзя.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function source(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf8')
}

/**
 * Исходник БЕЗ комментариев.
 *
 * ⚠ Без этого гард — пустышка, и это доказано ломкой: закомментированный вызов
 * `// useHead({ title: reportTitle('/app/leads') })` при полностью нерабочем коде оставлял тест
 * зелёным. Подстрока в комментарии — не вызов.
 */
function code(relative: string): string {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * ⚠ Ищем ВЫЗОВ, а не точную строку: сверка литералом краснела бы от переноса строки, а тест,
 * который ломается на переформатировании, скоро начнут чинить не глядя.
 */
function callsReportTitle(text: string, path: string): boolean {
  return new RegExp(`reportTitle\\(\\s*['"\`]${path}['"\`]\\s*\\)`).test(text)
}

describe('страницы берут заголовок из одного места', () => {
  it('каждый отчёт берёт имя вкладки из reportTitle, а не пишет литералом', () => {
    for (const report of APP_REPORTS) {
      const text = code(`app/pages${report.path}.vue`)
      expect(callsReportTitle(text, report.path)).toBe(true)
      // ⚠ Именно литерал и был дефектом: `useHead({ title: 'Отчёт' })` на отчёте 1.
      expect(text).not.toMatch(/useHead\(\s*\{\s*title:\s*['"`]/)
    }
  })

  /**
   * Заголовок НА ЭКРАНЕ — третья копия того же имени, после пункта меню и вкладки. Пока он был
   * литералом, переименование отчёта в `APP_REPORTS` меняло меню и вкладку, а шапку отчёта — нет.
   */
  it('шапка каждого отчёта берёт имя оттуда же, что меню и вкладка', () => {
    const toolbars: Record<string, string> = {
      '/app/leads': 'app/components/ReportToolbar.vue',
      '/app/managers': 'app/components/ManagerToolbar.vue',
      '/app/activity': 'app/components/ActivityToolbar.vue'
    }
    for (const report of APP_REPORTS) {
      const file = toolbars[report.path]
      expect(file, `нет шапки для ${report.path}`).toBeDefined()
      const text = code(file as string)
      expect(callsReportTitle(text, report.path)).toBe(true)
      // Литерал рядом с вызовом означал бы, что старая копия просто осталась.
      expect(text).not.toContain(`>\n        ${report.title}\n`)
    }
  })

  it('хвост заголовка склеивает pageTitle, а не сам app.vue', () => {
    const text = code('app/app.vue')
    expect(text).toContain('pageTitle')
    /**
     * ⚠ Ловим СКЛЕЙКУ, а не символ тире: прежняя редакция гарда запрещала «—» во всём файле и
     * покраснела бы от любого русского комментария. Дефект — шаблонная строка с подстановкой
     * (`${title} — …`) прямо здесь, каким бы разделителем её ни собрали.
     */
    expect(text).not.toMatch(/`[^`]*\$\{/)
    for (const report of APP_REPORTS) {
      expect(text).not.toContain(report.title)
    }
  })
})

describe('тексты, перечисляющие отчёты', () => {
  /**
   * ⚠ Экран «страница работает только внутри Битрикс24» называл ДВА отчёта из трёх: третий просто
   * забыли дописать, и человек, открывший его снаружи, читал инструкцию без своего отчёта.
   * Перечисление в свободном тексте — ровно то место, куда новый отчёт не добавляют.
   */
  it('экран «вне портала» называет каждый отчёт', () => {
    const text = code('app/components/InPortalGate.vue')
    for (const report of APP_REPORTS) {
      expect(text).toContain(report.title)
    }
  })
})

describe('имя приложения на экране', () => {
  /**
   * ⚠ Заголовок НА ЭКРАНЕ — та же строка, что во вкладке. Пока он был литералом, `APP_NAME`
   * существовал ради вкладки, а видимый заголовок продолжал жить своей жизнью: переименование
   * приложения поменяло бы вкладку и НЕ поменяло бы то, что человек читает.
   */
  it('страницы, называющие приложение, берут имя из APP_NAME', () => {
    for (const file of ['app/pages/index.vue', 'app/pages/app/index.vue']) {
      const text = code(file)
      expect(text).toContain('APP_NAME')
      expect(text).not.toContain(`>\n      ${APP_NAME}\n`)
    }
  })
})
