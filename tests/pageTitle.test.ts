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

describe('страницы берут заголовок из одного места', () => {
  /**
   * ⚠ Ищем ВЫЗОВ, а не точную строку: сверка литералом ломалась бы от переформатирования —
   * тест, который краснеет на переносе строки, скоро начнут чинить не глядя.
   */
  function callsReportTitle(code: string, path: string): boolean {
    const call = new RegExp(`reportTitle\\(\\s*['"\`]${path}['"\`]\\s*\\)`)
    return call.test(code)
  }

  it('каждый отчёт берёт имя вкладки из reportTitle, а не пишет литералом', () => {
    for (const report of APP_REPORTS) {
      const code = source(`app/pages${report.path}.vue`)
      expect(callsReportTitle(code, report.path)).toBe(true)
      // ⚠ Именно литерал и был дефектом: `useHead({ title: 'Отчёт' })` на отчёте 1.
      expect(code).not.toMatch(/useHead\(\s*\{\s*title:\s*['"`]/)
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
      const code = source(file as string)
      expect(callsReportTitle(code, report.path)).toBe(true)
      // Литерал рядом с вызовом означал бы, что старая копия просто осталась.
      expect(code).not.toContain(`>\n        ${report.title}\n`)
    }
  })

  it('хвост заголовка склеивает pageTitle, а не сам app.vue', () => {
    const code = source('app/app.vue')
    expect(code).toContain('pageTitle')
    // Прежняя редакция склеивала хвост прямо здесь — и зашила туда имя первого отчёта.
    expect(code).not.toContain('—')
    for (const report of APP_REPORTS) {
      expect(code).not.toContain(report.title)
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
    const code = source('app/components/InPortalGate.vue')
    for (const report of APP_REPORTS) {
      expect(code).toContain(report.title)
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
      const code = source(file)
      expect(code).toContain('APP_NAME')
      expect(code.replace(/^\s*\/\/.*$/gm, '')).not.toContain(`>\n      ${APP_NAME}\n`)
    }
  })
})
