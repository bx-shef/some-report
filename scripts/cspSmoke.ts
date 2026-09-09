import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { PORTAL_HANDLER_ROUTES, PRERENDER_ROUTES } from '../app/config/routes.ts'
import { HASH_PLACEHOLDER, applyHashes, buildHashDirective, htmlFiles, missingHashes } from './cspHashes.ts'

/**
 * Смоук: открыть собранную страницу НАСТОЯЩИМ браузером под боевым CSP и упасть на первом
 * нарушении.
 *
 * ⚠ Зачем, если есть `cspHashes` и `cspVerify`. Они оба зовут один и тот же разбор HTML, и ошибка
 * в самой классификации скриптов проходит через обоих зелёной. Ровно так в прод уехала
 * заблокированная импорт-карта: хеши на месте, проверка на месте, а приложение не стартовало
 * вообще — сервер отдавал 200, в логах пусто, на экране пред-отрендеренный HTML. Нашли руками,
 * открыв страницу браузером с боевым заголовком. Этот скрипт делает то же самое в CI.
 *
 * Что считается провалом: любое сообщение консоли о нарушении CSP, любая ошибка страницы,
 * не стартовавший Nuxt, отсутствие текста, который рисует ТОЛЬКО JavaScript. Последнее
 * важно: тексты из SSR-разметки есть и у мёртвой страницы — по ним поломку не отличить.
 *
 * Два режима:
 * - `pnpm smoke` — статика из `.output/public` под заголовком, собранным из `nginx.conf` в памяти.
 *   Быстро, без Docker; ловит ошибку классификации скриптов сразу после `pnpm generate`;
 * - `pnpm smoke:image <origin>` — уже поднятый сервер, то есть КОНТЕЙНЕР ИЗ ОБРАЗА. Заголовок
 *   берётся из живого ответа nginx, а не из конфига на диске. Это единственный вариант, который
 *   видит весь путь `Dockerfile` → `envsubst` → `nginx -t` → реальные `add_header` по `location`
 *   и `error_page 405 =200` — то, что локальный сервер лишь имитирует.
 *
 * ⛔ Директивы ВСТРАИВАНИЯ проверяются отдельно, и это самое ценное здесь. `frame-ancestors` и
 * `connect-src` дают худший класс инцидентов проекта — портал показывает ПУСТУЮ ОБЛАСТЬ без
 * единой ошибки на экране. Прежде смоук их не видел вовсе: страница открывается вне фрейма и без
 * запросов к REST, значит обе директивы не срабатывают никогда, и проверка руками после выката
 * была единственной. Теперь проверяются с ЧУЖОЙ стороны — так же, как ломается: страницу пробуют
 * встроить с другого origin, и со страницы стучатся на посторонний домен. Обе попытки обязаны
 * быть отвергнуты. Плюс сами списки доменов сверяются в живом заголовке.
 *
 * Браузер — системный Chrome раннера (`channel: 'chrome'`, без скачивания) либо путь из
 * `CSP_SMOKE_BROWSER`.
 */

/** Плейсхолдер доменов порталов в `nginx.conf`; подставляется при старте контейнера. */
export const ORIGINS_PLACEHOLDER = '${B24_PORTAL_ORIGINS}'

/** Что открыть и какой текст обязан появиться. Пустой список — только «без нарушений и со стартом Nuxt». */
export interface PageCheck {
  path: string
  /** Тексты, которые рисует ТОЛЬКО JavaScript, — их нет в SSR-разметке. Это проверяется перед прогоном. */
  mustContain: readonly string[]
}

/**
 * Страницы смоука. Список обязан покрывать `PRERENDER_ROUTES` — это проверяется и тестом, и самим
 * прогоном: новая страница, забытая здесь, уедет в статику непроверенной.
 *
 * Маркеры — литералы из страниц приложения (`app/pages/app/*.vue`), `app/utils/period.ts` и
 * `app/pages/install.vue`. Сменили там текст — обновите здесь: смоук упадёт с «нет текста «…»»,
 * и это не поломка CSP.
 */
export const PAGES: readonly PageCheck[] = [
  { path: '/', mustContain: [] },
  // Главная приложения: список отчётов есть в разметке, а плашку «вне портала» рисует только
  // клиент — после проверки, во фрейме мы или нет.
  { path: '/app/', mustContain: ['Страница открыта вне портала'] },
  // Вне портала `?preview=1` открывает заглушку на клиенте: плашка и панель периодов — только JS.
  { path: '/app/leads/?preview=1', mustContain: ['Это НЕ данные вашего портала', 'Текущий месяц'] },
  // Второй отчёт: демо-плашка, диаграмма «Распределение» и посчитанная матрица — тоже только JS.
  // «Итого по компании» есть только в таблице: заголовок страницы для маркера не годится, он
  // уезжает в SSR-разметку.
  { path: '/app/managers/?preview=1', mustContain: ['Это НЕ данные вашего портала', 'Распределение', 'Итого по компании'] },
  // Третий отчёт: демо-плашка, плитки итогов и таблица. Имя сотрудника — самый строгий маркер:
  // оно есть только в СТРОКЕ, то есть демо-набор досчитался ядром, а не просто нарисовалась
  // разметка.
  //
  // ⚠ Маркеры берём из ТАБЛИЦЫ, а не из карточек: до `lg` таблица скрыта, а с `lg` скрыты
  // карточки, и смоук ходит браузером в десктопной ширине. «Не дозвонился» (подпись карточки)
  // здесь не находился — в таблице тот же столбец подписан «Не дозв.».
  { path: '/app/activity/?preview=1', mustContain: ['Это НЕ данные вашего портала', 'Наговорили', 'Ковалёва Мария'] },
  // Установщик вне фрейма честно говорит об этом — но говорит это JavaScript, не разметка.
  { path: '/install/', mustContain: ['вне портала Битрикс24'] }
]

/** Маршрут пререндера для пути смоука: без query и завершающего слэша (`/app/?preview=1` → `/app`). */
export function routeOf(path: string): string {
  const pathname = path.split('?')[0] ?? path
  return pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname
}

/** Маршруты пререндера, для которых нет проверки. Пусто — смоук открывает всё, что уезжает в статику. */
export function uncoveredRoutes(pages: readonly PageCheck[], routes: readonly string[]): string[] {
  const covered = new Set(pages.map(page => routeOf(page.path)))
  return routes.filter(route => !covered.has(routeOf(route)))
}

/**
 * Маркеры страницы, которые ЕСТЬ в SSR-разметке.
 *
 * ⚠ Такой маркер не отличает живую страницу от мёртвой: заголовок «Установка приложения» был на
 * экране и у заблокированной импорт-карты. Стоит кому-то перенести текст плашки в серверный
 * рендер — и смоук по нему снова начнёт проходить на неработающей странице. Поэтому перед
 * прогоном проверяем, что маркеров в собранном HTML нет.
 */
export function markersInMarkup(check: PageCheck, html: string): string[] {
  return check.mustContain.filter(marker => html.includes(marker))
}

/**
 * Что в ответе сервера видно без браузера: заголовок есть, плейсхолдер хешей исчез, в `script-src`
 * нет `'unsafe-inline'`, у каждого инлайнового скрипта страницы есть хеш.
 *
 * ⚠ Браузер всё это тоже поймает — но как «Refused to execute inline script» без указания, ЧТО
 * именно не так. Отсутствие заголовка он не поймает вовсе: страница без CSP открывается лучше
 * всех. Поэтому проверяем явно и называем причину.
 */
export function cspProblems(csp: string | undefined, html: string): string[] {
  if (!csp) return ['нет заголовка Content-Security-Policy — защита снята целиком']
  const problems: string[] = []
  if (csp.includes(HASH_PLACEHOLDER)) problems.push(`в CSP остался плейсхолдер ${HASH_PLACEHOLDER} — браузер заблокирует собственный бандл`)
  const scriptSrc = directiveValue(csp, 'script-src')
  if (scriptSrc === undefined) return [...problems, 'в CSP нет script-src']
  if (scriptSrc.includes('\'unsafe-inline\'')) problems.push('в script-src есть \'unsafe-inline\' — защита от XSS снята')
  for (const { hash, snippet } of missingHashes(html, scriptSrc)) {
    problems.push(`инлайновый скрипт без хеша в script-src: ${hash} — «${snippet}»`)
  }
  return problems
}

/**
 * Что не так с директивами ВСТРАИВАНИЯ: `frame-ancestors` (кто может нас встроить) и `connect-src`
 * (куда мы имеем право ходить).
 *
 * ⛔ Именно эта пара даёт самый неприятный класс инцидентов проекта: портал показывает ПУСТУЮ
 * ОБЛАСТЬ без единой ошибки в интерфейсе. Ни браузерная часть смоука, ни тесты этого не видели:
 * страница открывается вне фрейма и без запросов к REST, то есть обе директивы не срабатывают
 * никогда. Проверка руками после выката была единственной — и она пропускается ровно тогда, когда
 * выкат срочный.
 *
 * ⚠ Оба списка задаются ОДНОЙ переменной `${B24_PORTAL_ORIGINS}` в `nginx.conf` и обязаны
 * совпадать: портал, которому позволено нас встроить, но к которому нам запрещено ходить, даёт
 * пустой отчёт во встроенном фрейме — худший из вариантов, потому что выглядит как «данных нет».
 *
 * ⚠ Уцелевший плейсхолдер — отдельная беда и отдельное сообщение. `NGINX_ENVSUBST_FILTER` в
 * `Dockerfile` перечисляет переменные поимённо; опечатка в фильтре оставляет `${…}` в живом
 * заголовке, браузер читает это как имя домена, и портал не проходит НИ ПО ОДНОЙ директиве.
 *
 * @param csp значение заголовка из ЖИВОГО ответа, а не из конфига на диске
 */
export function embeddingProblems(csp: string | undefined): string[] {
  if (!csp) return ['нет заголовка Content-Security-Policy — проверять встраивание не по чему']
  const problems: string[] = []
  const lists: Partial<Record<'frame-ancestors' | 'connect-src', string[]>> = {}
  for (const name of ['frame-ancestors', 'connect-src'] as const) {
    const value = directiveValue(csp, name)
    if (value === undefined) {
      // ⚠ Следствия у директив РАЗНЫЕ, и человек в логе идёт чинить по этой строке. У
      // `connect-src` есть откат на `default-src 'self'` — REST портала окажется закрыт, и отчёт
      // во фрейме будет пустым. У `frame-ancestors` отката нет вовсе: встроить сможет кто угодно.
      problems.push(name === 'frame-ancestors'
        ? 'в CSP нет frame-ancestors — встроить нас может кто угодно, защиты от кликджекинга нет'
        : 'в CSP нет connect-src — сработает откат на default-src, REST портала закрыт, отчёт во фрейме будет пустым')
      continue
    }
    if (value.includes(ORIGINS_PLACEHOLDER)) {
      problems.push(`в ${name} остался плейсхолдер ${ORIGINS_PLACEHOLDER} — envsubst не подставил домены порталов`)
    }
    const origins = value.split(/\s+/).filter(Boolean)
    // ⚠ `'self'` из сравнения убираем: у `connect-src` он про наш же домен, у `frame-ancestors` —
    // про нас как родителя. Совпадать обязаны именно ДОМЕНЫ ПОРТАЛОВ.
    lists[name] = origins.filter(origin => origin !== '\'self\'').sort()
    if (!lists[name].length) {
      problems.push(`в ${name} нет ни одного домена портала — во фрейме портала будет пустая область без ошибки`)
    }
    if (origins.includes('*')) {
      problems.push(`в ${name} стоит * — список доменов порталов не ограничивает никого`)
    }
    /**
     * ⛔ Опечатка в домене опаснее звёздочки, потому что выглядит как настоящий список.
     * `https://*.by` вместо `https://*.bitrix24.by` — это ЛЮБОЙ сайт в зоне `.by`: он сможет
     * встроить отчёт и получить данные CRM. Ни валидатор доменов при сборке, ни сравнение
     * списков между директивами такого не видят — оба считают значение нормальным.
     *
     * Отличаем по числу меток после звёздочки: у боевых доменов их две и больше
     * (`*.bitrix24.by`), у опечатки — одна (`*.by`).
     */
    for (const origin of origins) {
      const host = origin.replace(/^[a-z]+:\/\//i, '')
      if (host.startsWith('*.') && host.split('.').length < 3) {
        problems.push(`в ${name} слишком широкий домен ${origin} — под него попадает вся зона целиком; похоже на опечатку в ${ORIGINS_PLACEHOLDER}`)
      }
    }
    // ⚠ `'none'` — не «пусто», а ЗАПРЕТ всем. У `frame-ancestors` это значит, что портал не
    // встроит нас вообще: пустая область вместо отчёта, и опять без единой ошибки на экране.
    if (origins.includes('\'none\'')) {
      problems.push(`в ${name} стоит 'none' — запрещено всем, портал получит пустую область вместо отчёта`)
    }
  }
  const ancestors = lists['frame-ancestors']
  const connect = lists['connect-src']
  if (ancestors && connect && ancestors.join(' ') !== connect.join(' ')) {
    problems.push(`списки доменов в frame-ancestors и connect-src РАЗОШЛИСЬ: «${ancestors.join(' ')}» против «${connect.join(' ')}» — портал сможет нас встроить, но не сможет отдать данные`)
  }
  return problems
}

/** Что за ответ проверяем заголовками: документ или ассет с хешем в имени. */
export type ResponseKind = 'document' | 'asset'

/** Ожидаемый `Cache-Control` ассета — ОДНОЙ строкой, см. `headerProblems`. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Заголовки безопасности, которые `nginx.conf` повторяет в `location /_nuxt/`. Проверяются
 * НАБОРОМ, а не поимённо: локация переобъявляет четыре, и перечислять их здесь по одному значило
 * бы сторожить ровно те, о которых вспомнил автор проверки.
 */
export const SECURITY_HEADERS = ['x-content-type-options', 'referrer-policy', 'permissions-policy'] as const

/**
 * Заголовки ответа, которые ломаются молча и видны только на НАСТОЯЩЕМ nginx.
 *
 * ⚠ Текст конфига сторожит `tests/nginxConf.test.ts`, и этого мало: между конфигом и ответом
 * лежит правило nginx «локация со своим `add_header` НЕ наследует серверные». Заголовок, забытый
 * в `location /_nuxt/`, в конфиге выглядит как обычная строка выше по файлу — а до ассетов не
 * доезжает. Увидеть это можно только по живому ответу.
 *
 * ⚠ `Cache-Control` у ассета сверяется ЦЕЛОЙ СТРОКОЙ, а не по подстроке `max-age`. Директива
 * `expires` печатает свой `Cache-Control`, и вместе с `add_header` заголовок уходил ДВУМЯ
 * строками (замечено на живом выкате). Две строки с одним именем — две политики кэша, и какая
 * применится, зависит от реализации.
 *
 * @param kind документ или ассет — у них РАЗНЫЙ ожидаемый `Cache-Control`, и перепутать их значит
 *   пропустить либо вечный кэш на HTML, либо отсутствие кэша на ассетах
 * @param raw заголовки живого ответа; регистр имён приводим здесь, а не полагаемся на вызывающего:
 *   функция экспортирована, и второй вызывающий с `Cache-Control` получил бы правдоподобный, но
 *   неверный диагноз «заголовка нет»
 */
export function headerProblems(kind: ResponseKind, raw: Record<string, string>): string[] {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) headers[name.toLowerCase()] = value

  const problems: string[] = []
  const cache = headers['cache-control']
  if (kind === 'document') {
    if (!cache) problems.push('у документа нет Cache-Control — браузер применит эвристику и будет держать старую сборку часами')
    else if (!cache.includes('no-cache')) problems.push(`у документа Cache-Control «${cache}» без no-cache — в портале это выглядит как невыкаченная правка`)
  } else {
    if (!cache) problems.push('у ассета /_nuxt/ нет Cache-Control — вечный кэш не работает, каждый заход тянет бандл заново')
    // ⚠ Сравнение ЦЕЛИКОМ: склеенные политики («max-age=31536000, public, immutable») дают
    // подстроку `max-age` и прошли бы проверку по включению — а это ровно тот дефект.
    else if (cache !== ASSET_CACHE_CONTROL) {
      // Причину не утверждаем: значение могли поменять и намеренно. Называем расхождение и
      // подсказываем самую частую причину — иначе смоук отправит чинить несуществующий дубль.
      problems.push(`у ассета /_nuxt/ Cache-Control «${cache}» вместо ожидаемого «${ASSET_CACHE_CONTROL}» — либо заголовок ушёл дважды (expires + add_header), либо значение поменяли и забыли про смоук`)
    }
  }
  return problems
}

/**
 * Заголовки безопасности, которые есть у документа, но пропали у ассета.
 *
 * ⚠ Сверяем с ДОКУМЕНТОМ, а не со списком в коде: `location /_nuxt/` повторяет серверные
 * заголовки, и любой из них можно забыть при правке. Список в коде сторожил бы только те, что
 * автор проверки вспомнил, — а забывают как раз невспомненные.
 */
export function lostSecurityHeaders(document: Record<string, string>, asset: Record<string, string>): string[] {
  const at = (headers: Record<string, string>, name: string): string | undefined => {
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value
    return undefined
  }
  return SECURITY_HEADERS
    .filter(name => at(document, name) !== undefined && at(asset, name) === undefined)
    .map(name => `у ассета /_nuxt/ нет заголовка ${name}, а у документа он есть — nginx не наследует add_header в локацию со своими заголовками`)
}

/**
 * Первый ассет `/_nuxt/` из разметки страницы — по нему и проверяются заголовки локации.
 *
 * Берём из живой разметки, а не из списка файлов сборки: имя с хешем меняется каждой сборкой, и
 * захардкоженный путь превратил бы проверку в «404 отдаёт правильные заголовки».
 */
export function firstAssetPath(html: string): string | undefined {
  // ⚠ Привязка к `src`/`href`, а не любая строка в кавычках: в разметке есть JSON гидратации, и
  // совпасть могла бы строка оттуда — тогда смоук проверял бы заголовки несуществующего адреса.
  return /(?:src|href)=["'](\/_nuxt\/[^"']+\.(?:js|mjs|css))["']/.exec(html)?.[1]
}

/**
 * Значение директивы по точному имени. Не regex по подстроке: `script-src-attr 'none'`, стоящая
 * раньше `script-src`, подошла бы под `/script-src([^;]*)/` и «съела» бы настоящую директиву.
 */
export function directiveValue(csp: string, name: string): string | undefined {
  for (const part of csp.split(';')) {
    const [directive, ...rest] = part.trim().split(/\s+/)
    if (directive === name) return rest.join(' ')
  }
  return undefined
}

/**
 * Origin из аргумента `--origin`. Только http(s): `localhost:8080` без схемы `new URL` принимает,
 * но origin у него «null», и смоук упал бы пятью «Cannot navigate to invalid URL» вместо подсказки.
 */
export function parseOrigin(value: string | undefined): string {
  let url: URL | undefined
  try {
    url = new URL(value ?? '')
  } catch {
    url = undefined
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`«${value ?? ''}» — не адрес сервера; нужен http(s)://host:port`)
  }
  return url.origin
}

/**
 * Пути, которые портал открывает POST-запросом: обработчики плейсмента и установки.
 *
 * ⚠ Статике POST не положен, и nginx по умолчанию отвечает 405 — виджет показывал бы пустоту при
 * исправной сборке. Это лечит `error_page 405 =200 $uri` в `nginx.conf`, и проверить его можно
 * только на настоящем nginx: локальный сервер смоука на метод не смотрит.
 */
export function postPaths(routes: readonly string[]): string[] {
  return routes.map(route => `${routeOf(route)}/`)
}

/**
 * Значение CSP из `add_header Content-Security-Policy "…"`.
 *
 * Отсутствие директивы — ошибка, а не «проверять нечего»: конфиг без CSP в проде означал бы,
 * что защиту сняли, и смоук, молча прошедший по пустому заголовку, ровно это и скрыл бы.
 * Якорь `^\s*` — чтобы закомментированная строка (`# add_header …`) за директиву не сошла:
 * иначе снятая на время отладки защита прошла бы смоук как живая.
 */
export function extractCspHeader(conf: string): string {
  const matches = [...conf.matchAll(/^\s*add_header\s+Content-Security-Policy\s+"([^"]*)"/gim)]
  if (!matches[0]?.[1]) throw new Error('В nginx.conf нет add_header Content-Security-Policy')
  // ⚠ nginx не наследует add_header в location со своими заголовками — второй CSP в другом
  // location был бы отдельной политикой, и смоук, взяв первую, проверил бы не ту. Пока
  // директива одна; появится вторая — сюда придёт автор и решит, какую гонять.
  if (matches.length > 1) throw new Error(`В nginx.conf ${matches.length} директивы Content-Security-Policy — смоук умеет проверять одну`)
  return matches[0][1]
}

/**
 * Домены порталов в заголовке.
 *
 * ⚠ Значение ЗНАЧИМО: `embeddingProblems` разбирает список, а `checkEnforcement` проверяет его
 * действие живым браузером. Прежде тут стояло «для смоука значение не важно» — это было верно,
 * пока страницу никто не встраивал.
 */
export function substituteOrigins(csp: string, origins: string): string {
  return csp.replaceAll(ORIGINS_PLACEHOLDER, origins)
}

/** Сообщение консоли — о нарушении CSP? Формулировки Chromium: «Refused to …», «Content Security Policy». */
export function isCspViolation(text: string): boolean {
  return /Refused to|Content Security Policy/i.test(text)
}

/**
 * Сообщение консоли — отказ ИМЕННО по названной директиве?
 *
 * ⛔ Проверять по слову нельзя, и это не теория. Замер на живом Chromium (2026-09-08):
 *
 *   frame-ancestors → «Refused to frame '…' because an ancestor violates the following Content
 *                      Security Policy directive: "frame-ancestors 'self'".»
 *   frame-src       → «Refused to frame '…' because it violates the following Content Security
 *                      Policy directive: "frame-src 'none'".»
 *
 * Слово «frame» есть в обоих. У нас в политике `frame-src 'none'` стоит, значит вложенный фрейм
 * на проверяемой странице закрыл бы проверку `frame-ancestors` ВМЕСТО неё самой — ложный зелёный
 * ровно там, где проверка должна краснеть. Спасает то, что Chromium печатает название
 * нарушенной директивы дословно и в кавычках: по нему и опознаём.
 */
export function isViolationOf(text: string, directive: string): boolean {
  return isCspViolation(text) && text.includes(`"${directive} `)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/**
 * Статика с боевым заголовком на свободном порту. `root` — абсолютный путь.
 *
 * Экспортирована ради теста: браузера ей не нужно, а выход за корень и отдача `index.html`
 * каталогу — ровно то, что дешевле поймать тестом, чем ревью.
 */
export async function serve(root: string, csp: string): Promise<{ origin: string, close: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      let file = join(root, pathname)
      // Не выйти за корень: `..` в пути `join` схлопывает, и итог может оказаться выше `root`.
      const inside = relative(root, file)
      if (inside.startsWith('..') || isAbsolute(inside)) {
        res.writeHead(403)
        return res.end()
      }
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('сервер не поднялся')
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

interface PageResult {
  path: string
  problems: string[]
}

async function checkPage(origin: string, check: PageCheck, browser: Browser): Promise<PageResult> {
  const problems: string[] = []
  const page = await browser.newPage()
  page.on('console', (message) => {
    if (isCspViolation(message.text())) problems.push(`CSP: ${message.text().slice(0, 160)}`)
  })
  page.on('pageerror', error => problems.push(`ошибка страницы: ${error.message.slice(0, 160)}`))
  try {
    const response = await page.goto(origin + check.path, { waitUntil: 'networkidle', timeout: 45_000 })
    if (!response) throw new Error('сервер не ответил')
    if (response.status() !== 200) problems.push(`HTTP ${response.status()}`)
    // Заголовок и разметку берём из ответа, а не из конфига или файла: в режиме образа это
    // единственный источник правды, а в локальном — та же проверка, что и в CI.
    const html = await response.text()
    // `allHeaders()`, а не `headers()`: второй по документации Playwright может не отдавать
    // заголовки безопасности — и «нет заголовка CSP» на всех PR было бы ложным.
    problems.push(...cspProblems((await response.allHeaders())['content-security-policy'], html))
    for (const marker of markersInMarkup(check, html)) {
      problems.push(`маркер «${marker}» есть в SSR-разметке — он не отличает живую страницу от мёртвой`)
    }
    // Старт Nuxt. ⚠ Не по атрибуту `data-v-app`: его ставит только `createApp`, а Nuxt гидрирует
    // через `createSSRApp`, который атрибут не ставит вовсе, — проверка по нему падала на живой
    // странице. Надёжный признак — сам Nuxt: `useNuxtApp` в `window` появляется только после
    // старта клиента, а `isHydrating` сбрасывается, когда Vue закончил сверять разметку.
    // Ждём именно этого события, а не таймер: на загруженном раннере фиксированная пауза
    // либо мала (ложный провал), либо велика (медленный шаг).
    const hydrated = await page
      .waitForFunction(() => {
        const nuxt = (window as unknown as { useNuxtApp?: () => { isHydrating?: boolean } }).useNuxtApp?.()
        return Boolean(nuxt) && nuxt?.isHydrating !== true
      }, undefined, { timeout: 15_000 })
      .then(() => true, () => false)
    if (!hydrated) problems.push('Nuxt не стартовал в браузере: JavaScript не выполнился')
    const text = await page.evaluate(() => document.body.innerText)
    for (const expected of check.mustContain) {
      if (!text.includes(expected)) problems.push(`нет текста «${expected}» — его рисует только JavaScript`)
    }
  } catch (error) {
    problems.push(`не открылась: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
  } finally {
    await page.close()
  }
  return { path: check.path, problems }
}

/**
 * POST на обработчик — ответ 200, та же страница, что по GET, и тот же CSP.
 *
 * Без браузера, через `fetch`: это проверка nginx, а не страницы, и не должна зависеть от того,
 * нашёлся ли Chrome. Заголовок проверяем и здесь: именно этот ответ портал и рисует, а
 * `error_page` с именованной локацией мог бы отдать его без серверных `add_header`.
 */
async function checkPost(origin: string, path: string): Promise<PageResult> {
  const problems: string[] = []
  try {
    const response = await fetch(origin + path, { method: 'POST', signal: AbortSignal.timeout(15_000) })
    const body = await response.text()
    if (response.status !== 200) problems.push(`HTTP ${response.status} — портал открывает обработчик POST-запросом и увидит пустоту`)
    else if (!body.includes('id="__nuxt"')) problems.push('в ответе нет разметки приложения')
    problems.push(...cspProblems(response.headers.get('content-security-policy') ?? undefined, body))
    // ⚠ Этот ответ портал и рисует во фрейме — значит `Cache-Control` и заголовки безопасности у
    // него обязаны быть те же, что у обычного документа. `error_page` с именованной локацией мог
    // бы отдать его без серверных `add_header`, и кэшируемый HTML выглядел бы как невыкаченная
    // правка ровно там, где её замечают позже всего.
    problems.push(...headerProblems('document', Object.fromEntries(response.headers)))
  } catch (error) {
    problems.push(`запрос не прошёл: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
  }
  return { path: `POST ${path}`, problems }
}

/** Заголовки ответа с именами в нижнем регистре. */
function headersOf(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers)
}

/**
 * Документ и ассет `/_nuxt/`: заголовки локаций плюс директивы встраивания.
 *
 * ⚠ Документ скачивается ОДИН раз и отдаёт сразу обе проверки — заголовки и CSP. Два отдельных
 * запроса за одной и той же страницей стоили бы лишний круг по сети на каждом прогоне CI.
 *
 * ⚠ Заголовки ассета проверяются только при 200. На 404 nginx отдаёт `/404.html` серверными
 * заголовками, и проверка честно, но бессмысленно ругалась бы на `Cache-Control: no-cache` у
 * «ассета» — отправляя чинить несуществующий дубль `add_header` вместо пропавшего файла.
 */
async function checkDocumentAndAsset(origin: string, withLocations: boolean): Promise<PageResult[]> {
  const results: PageResult[] = []
  try {
    const document = await fetch(`${origin}/`, { signal: AbortSignal.timeout(15_000) })
    const html = await document.text()
    const documentHeaders = headersOf(document)
    results.push({
      path: 'CSP: домены порталов',
      problems: embeddingProblems(documentHeaders['content-security-policy'])
    })
    if (!withLocations) return results

    results.push({ path: 'заголовки документа /', problems: headerProblems('document', documentHeaders) })
    const asset = firstAssetPath(html)
    if (!asset) {
      results.push({ path: 'заголовки ассета /_nuxt/', problems: ['в разметке / нет ссылки на /_nuxt/ — проверять локацию не на чем'] })
      return results
    }
    const response = await fetch(origin + asset, { signal: AbortSignal.timeout(15_000) })
    await response.body?.cancel()
    if (response.status !== 200) {
      results.push({ path: `заголовки ассета ${asset}`, problems: [`HTTP ${response.status} — ассета из разметки нет на сервере, заголовки локации проверить не на чем`] })
      return results
    }
    const assetHeaders = headersOf(response)
    results.push({
      path: `заголовки ассета ${asset}`,
      problems: [...headerProblems('asset', assetHeaders), ...lostSecurityHeaders(documentHeaders, assetHeaders)]
    })
  } catch (error) {
    results.push({ path: 'заголовки ответа', problems: [`запрос не прошёл: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`] })
  }
  return results
}

/** Одностраничный сервер на свободном порту — ЧУЖОЙ origin для проверки `frame-ancestors`. */
async function serveDocument(html: string): Promise<{ origin: string, close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('сервер-«портал» не поднялся')
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

/**
 * Отказ ИМЕННО по названной директиве.
 *
 * ⛔ Совпадение по слову «frame» давало ЛОЖНЫЙ ЗЕЛЁНЫЙ. Замер на живом Chromium: нарушение
 * `frame-src` печатается как «Refused to frame '…' because it violates … "frame-src 'none'"» —
 * то же слово, другая директива. У нас в политике `frame-src 'none'` стоит, и вложенный фрейм на
 * проверяемой странице закрывал бы проверку `frame-ancestors` вместо неё самой. То же у
 * `X-Frame-Options`: «Refused to display … 'X-Frame-Options'». Поэтому ищем НАЗВАНИЕ директивы —
 * Chromium печатает его в кавычках дословно.
 *
 * ⚠ Ждём СОБЫТИЕ, а не фиксированную паузу циклом: на загруженном раннере пауза либо мала
 * (ложный провал), либо велика (медленный шаг). Подписка оформляется ДО действия — иначе
 * сообщение успевает прийти раньше, чем его начали слушать.
 */
async function refusedBy(page: Page, directive: string, act: () => Promise<unknown>): Promise<boolean> {
  const seen = page
    .waitForEvent('console', {
      predicate: message => isViolationOf(message.text(), directive),
      timeout: 20_000
    })
    .then(() => true, () => false)
  try {
    await act()
  } catch {
    // Действие могло упасть само (страница не открылась) — тогда отказа не будет, и это провал
    // проверки, а не исключение: причину назовёт вызывающий.
  }
  return seen
}

/**
 * ⛔ Главная проверка этой задачи: директивы встраивания РАБОТАЮТ, а не просто написаны.
 *
 * Обе проверяются с ЧУЖОЙ стороны, потому что именно чужая сторона и ломается молча:
 *
 * 1. `frame-ancestors` — страница открывается во фрейме документа с другого origin (свой порт,
 *    значит другой origin) и обязана быть ОТВЕРГНУТА. Пройди она — нас мог бы встроить кто угодно;
 * 2. `connect-src` — со страницы делается `fetch` на посторонний домен и обязан быть ОТВЕРГНУТ.
 *    Пройди он — приложение могло бы отправить данные CRM куда угодно.
 *
 * ⚠ Домен пробы — `.invalid`: он не резолвится по стандарту, поэтому «запрос ушёл в сеть» и
 * «запрос отвергнут политикой» здесь не перепутать, а из CI наружу ничего не уходит.
 *
 * ⚠ Нарушения тут ОЖИДАЕМЫ, поэтому проверка живёт отдельно от `checkPage`: там любое сообщение
 * о нарушении CSP — провал, и складывать их в один обработчик значило бы либо ослабить тот, либо
 * получить ложный провал здесь.
 *
 * ⚠ Чего эта проверка НЕ делает: она не сверяет САМ СПИСОК доменов с эталоном. Забытый домен
 * конкретного заказчика тут не всплывёт — его сторожит `tests/nginxConf.test.ts` по `Dockerfile`.
 */
async function checkEnforcement(origin: string, browser: Browser): Promise<PageResult[]> {
  const results: PageResult[] = []
  const portal = await serveDocument(`<!doctype html><meta charset="utf-8"><iframe src="${origin}/app/"></iframe>`)
  try {
    const page = await browser.newPage()
    try {
      const refused = await refusedBy(page, 'frame-ancestors', () => page.goto(portal.origin, { waitUntil: 'load', timeout: 30_000 }))
      results.push({
        path: 'frame-ancestors: чужой origin не может нас встроить',
        problems: refused ? [] : ['страница открылась во фрейме ЧУЖОГО документа — frame-ancestors не применяется, встроить нас может кто угодно']
      })
    } finally {
      await page.close()
    }
  } finally {
    portal.close()
  }

  const probe = await browser.newPage()
  try {
    await probe.goto(`${origin}/app/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // Результат самого `fetch` не важен: при работающей политике он падает ДО сети. Важно, что
    // браузер сказал об отказе — иначе запрос ушёл бы в сеть и упал уже по своей причине.
    const refused = await refusedBy(probe, 'connect-src', () =>
      probe.evaluate(() => fetch('https://blocked-by-smoke.invalid/probe').catch(() => undefined)))
    results.push({
      path: 'connect-src: посторонний домен закрыт',
      problems: refused ? [] : ['запрос на посторонний домен не отвергнут политикой — connect-src не применяется, данные CRM можно отправить куда угодно']
    })
  } catch (error) {
    results.push({ path: 'connect-src: посторонний домен закрыт', problems: [`не проверилось: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`] })
  } finally {
    await probe.close()
  }
  return results
}

const USAGE = `Использование:
  cspSmoke.ts <каталог статики> <nginx.conf>   локальный сервер с заголовком из конфига
  cspSmoke.ts --origin <URL>                   уже поднятый сервер (контейнер из образа)`

/** Локальный сервер: заголовок собирается из `nginx.conf` в памяти, конфиг на диске не трогаем. */
async function serveBuild(dir: string, configPath: string): Promise<{ origin: string, close: () => void }> {
  const root = resolve(dir)
  const pages = await Promise.all((await htmlFiles(root)).map(file => readFile(file, 'utf-8')))
  if (!pages.length) throw new Error(`В ${dir} нет ни одного .html — сборка пуста?`)
  const conf = applyHashes(await readFile(configPath, 'utf-8'), buildHashDirective(pages))
  // ⚠ `||`, а не `??`: ПУСТАЯ строка в переменной — не значение, а её отсутствие. С `??` пустая
  // строка доезжала до заголовка (`frame-ancestors 'self' ;`), и смоук падал, обвиняя исправный
  // конфиг. Контейнер на пустое значение тоже не поднимается (`deploy/validate-portal-origins.sh`).
  const csp = substituteOrigins(extractCspHeader(conf), process.env.B24_PORTAL_ORIGINS || 'https://*.bitrix24.by')
  return serve(root, csp)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const uncovered = uncoveredRoutes(PAGES, PRERENDER_ROUTES)
  if (uncovered.length) throw new Error(`маршруты пререндера без проверки: ${uncovered.join(', ')} — добавьте их в PAGES`)

  const imageMode = args[0] === '--origin'
  let server: { origin: string, close: () => void }
  if (imageMode) {
    server = { origin: parseOrigin(args[1]), close: () => {} }
  } else {
    const [dir, configPath] = args
    if (!dir || !configPath) throw new Error(USAGE)
    server = await serveBuild(dir, configPath)
  }

  // POST — только на образе: локальный сервер на метод не смотрит, и зелёная галочка там ничего
  // не значила бы. Идёт до браузера: nginx проверяется и тогда, когда Chrome не нашёлся.
  const results: PageResult[] = []
  // Директивы встраивания — в ОБОИХ режимах: заголовок и локально собран из `nginx.conf`, значит
  // сломанную политику видно уже на PR. Заголовки локаций — только на образе: локальный сервер о
  // `location` ничего не знает, и зелёная галочка там значила бы «проверили сами себя».
  results.push(...await checkDocumentAndAsset(server.origin, imageMode))
  if (imageMode) {
    for (const path of postPaths(PORTAL_HANDLER_ROUTES)) results.push(await checkPost(server.origin, path))
  } else {
    console.log('[smoke] POST и заголовки локаций: пропущено — проверяется только на образе (pnpm smoke:image)')
  }

  // Браузер подключаем только здесь: тесты импортируют чистые функции выше и тянуть playwright не должны.
  const { chromium } = await import('playwright-core')
  const executablePath = process.env.CSP_SMOKE_BROWSER
  let browser: Browser | undefined
  let launchError: unknown
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' })
    for (const check of PAGES) results.push(await checkPage(server.origin, check, browser))
    results.push(...await checkEnforcement(server.origin, browser))
  } catch (error) {
    // ⚠ Не бросаем сразу: без браузера уже посчитаны проверки nginx — CSP, POST, заголовки
    // локаций. Прежде они молча терялись вместе с исключением, и лог показывал одну строку про
    // запуск Chrome, хотя рядом лежал готовый ответ, почему сломан выкат.
    launchError = error
  } finally {
    await browser?.close()
    server.close()
  }

  let failed = 0
  for (const { path, problems } of results) {
    if (problems.length) {
      failed++
      console.error(`[smoke] ✕ ${path}`)
      for (const problem of problems) console.error(`         ${problem}`)
    } else {
      console.log(`[smoke] ✓ ${path}`)
    }
  }
  if (launchError) throw launchError
  if (failed) throw new Error(`проверок с проблемами: ${failed} из ${results.length}`)
  console.log(`[smoke] ${server.origin}: все ${results.length} проверки прошли под боевым CSP без нарушений`)
}

// Запуск только как CLI: при импорте из теста main() не должен ничего поднимать.
if (process.argv[1]?.endsWith('cspSmoke.ts')) {
  main().catch((error) => {
    console.error(`[smoke] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
