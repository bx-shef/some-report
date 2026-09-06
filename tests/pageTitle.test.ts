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
  it('каждый отчёт зовёт reportTitle со своим путём, а не пишет имя литералом', () => {
    for (const report of APP_REPORTS) {
      const file = `app/pages${report.path}.vue`
      const code = source(file)
      expect(code).toContain(`useHead({ title: reportTitle('${report.path}') })`)
      // ⚠ Именно литерал и был дефектом: `useHead({ title: 'Отчёт' })` на отчёте 1.
      expect(code).not.toMatch(/useHead\(\{\s*title:\s*['"`]/)
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
