/**
 * Разбор того, что портал НА САМОМ ДЕЛЕ знает про наше приложение после установки.
 *
 * ⚠ Зачем отдельный модуль. Страница установки раньше показывала ✓ по ответу `placement.bind` —
 * то есть «мы попросили, портал не возразил». Ровно этого оказалось недостаточно: заказчик
 * прошёл установку, увидел зелёное «Готово» и НЕ НАШЁЛ отчёт в портале. По ответу `bind`
 * неотличимы четыре разные ситуации:
 *
 * 1. приложению не выдали право `crm` или `placement` — точка не регистрируется вовсе;
 * 2. точки привязаны, но `installFinish` не прошёл — портал считает приложение неустановленным
 *    и НЕ ПОКАЗЫВАЕТ виджеты (это прямо написано в документации обеих точек);
 * 3. точки привязаны на ПРОШЛЫЙ адрес обработчика (переехали на другой домен) — пункт в меню
 *    есть, но открывает старое приложение или пустоту;
 * 4. всё зарегистрировано верно, а человек просто не перезагрузил страницу портала — левое меню
 *    отдаётся из кэша.
 *
 * Лечится каждая своим действием, поэтому диагноз должен различать их и называть действие.
 * Логика здесь — чистые функции: страница только рисует, а `placement.get`/`app.info`/`scope`
 * зовёт вызывающая сторона.
 */

/** Что портал вернул из `placement.get` — одна зарегистрированная привязка. */
export interface RegisteredPlacement {
  /** Код точки встраивания, например `CRM_ANALYTICS_MENU`. */
  code: string
  /** Адрес обработчика, который откроет портал по нажатию. */
  handler: string
}

/**
 * Состояние одного ожидаемого пункта:
 * - `ok` — привязан на наш адрес;
 * - `other-handler` — точка привязана, но ни один её обработчик не совпал с нашим (переезд
 *   домена, установка прошлой версии, где путь был другим);
 * - `missing` — точка не привязана вовсе.
 */
export type PlacementStatus = 'ok' | 'other-handler' | 'missing'

/**
 * Что мы ждём увидеть в портале: КОД ТОЧКИ И АДРЕС.
 *
 * ⚠ Пары, а не просто коды, и это не усложнение ради строгости. В одной точке
 * (`CRM_ANALYTICS_MENU`) теперь ДВА наших пункта — по одному на отчёт, — и проверка «код
 * встречается в списке» показывала бы зелёное «всё зарегистрировано», когда привязан только
 * один из двух: человек открыл бы аналитику и не нашёл там второй отчёт.
 */
export interface ExpectedPlacement {
  code: string
  handler: string
  /** Заголовок пункта — только для диагностики на экране. */
  title?: string
}

export interface PlacementCheck {
  code: string
  /** Адрес, который мы ждали у этого пункта. */
  handler: string
  title?: string
  status: PlacementStatus
  /** Чужие адреса, найденные у этой точки, — их видно в диагностике как есть. */
  foreignHandlers: string[]
}

export type InstallLevel = 'ok' | 'warning' | 'error'

export interface InstallVerdict {
  level: InstallLevel
  /** Одна строка: что сейчас с установкой. */
  title: string
  /** Что сделать дальше. Пусто — делать нечего. */
  hint: string
}

/**
 * Приведение адреса обработчика к сравнимому виду.
 *
 * ⚠ Сравнивать строки «как есть» нельзя: портал хранит то, что мы прислали, а прислать мы могли
 * адрес с хвостовым слешем или с заглавными буквами в домене — и тогда наша же привязка
 * определилась бы как «чужая», а страница предлагала бы перепривязать точку по кругу.
 * Схему и хост складываем в нижний регистр (они регистронезависимы), путь оставляем как есть
 * (он регистрозависим), хвостовой слеш срезаем.
 */
export function normalizeHandlerUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`
  } catch {
    // Не разобрался как URL — сравним хотя бы без хвостового слеша, чем промолчим.
    return trimmed.replace(/\/+$/, '')
  }
}

/**
 * Разбор ответа `placement.get`.
 *
 * ⚠ Ключи проверяем в двух регистрах: регистрировали мы точку параметрами `PLACEMENT`/`HANDLER`,
 * а список портал отдаёт полями `placement`/`handler`. Форму ответа читаем в рантайме, а не
 * приводим через `as`: слепое приведение при смене формата промолчит, а диагностика начнёт
 * показывать «ничего не зарегистрировано» на исправной установке — то есть врать.
 */
export function parseRegisteredPlacements(raw: unknown): RegisteredPlacement[] {
  if (!Array.isArray(raw)) return []
  const result: RegisteredPlacement[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const code = pickString(row.placement) ?? pickString(row.PLACEMENT)
    if (!code) continue
    result.push({ code, handler: pickString(row.handler) ?? pickString(row.HANDLER) ?? '' })
  }
  return result
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Состояние каждого ожидаемого пункта против того, что реально зарегистрировано в портале. */
export function checkPlacements(
  expected: readonly ExpectedPlacement[],
  registered: readonly RegisteredPlacement[]
): PlacementCheck[] {
  return expected.map((item) => {
    const rows = registered.filter(row => row.code === item.code)
    const ours = normalizeHandlerUrl(item.handler)
    const base = { code: item.code, handler: item.handler, ...(item.title ? { title: item.title } : {}) }
    if (rows.length === 0) return { ...base, status: 'missing', foreignHandlers: [] }
    const foreignHandlers = rows
      .filter(row => normalizeHandlerUrl(row.handler) !== ours)
      .map(row => row.handler)
    // Наша привязка есть — пункт рабочий, даже если рядом в той же точке висит чужая.
    if (foreignHandlers.length < rows.length) return { ...base, status: 'ok', foreignHandlers }
    return { ...base, status: 'other-handler', foreignHandlers }
  })
}

/**
 * Лишние привязки: те, что портал помнит за нашим приложением, а мы больше не регистрируем.
 *
 * ⚠ Появились они не из воздуха: до 2026-09-05 приложение регистрировало один пункт на главную
 * приложения и кнопку в шапке аналитики. После переустановки поверх старой установки они
 * остались бы рядом с новыми — три входа вместо двух, причём старый ведёт в промежуточную
 * страницу. Молчать об этом нельзя: человек, увидев в меню лишний пункт, решит, что приложение
 * установилось дважды.
 */
export function extraPlacements(
  expected: readonly ExpectedPlacement[],
  registered: readonly RegisteredPlacement[]
): RegisteredPlacement[] {
  const ours = new Set(expected.map(item => `${item.code}|${normalizeHandlerUrl(item.handler)}`))
  return registered.filter(row => !ours.has(`${row.code}|${normalizeHandlerUrl(row.handler)}`))
}

/** Каких прав портал приложению не выдал. Порядок — как в списке требуемых. */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(granted.map(scope => scope.trim().toLowerCase()).filter(Boolean))
  return required.filter(scope => !have.has(scope.trim().toLowerCase()))
}

export interface InstallState {
  /** `INSTALLED` из `app.info`: портал считает установку завершённой. `undefined` — не удалось узнать. */
  appInstalled?: boolean
  /** Права, которых не хватает (см. `missingScopes`). */
  missing: readonly string[]
  /**
   * Удалось ли вообще спросить портал про точки встраивания.
   *
   * ⚠ Поле обязательное, и это осознанно. Без него «`placement.get` не ответил» и «точек не
   * ожидалось» приходили сюда одинаковым пустым списком, и вердикт падал в «всё хорошо» — то
   * есть страница показывала зелёное «Готово», НИЧЕГО НЕ ПРОВЕРИВ. Ровно та болезнь, ради
   * лечения которой написан весь модуль. Обязательность заставляет вызывающую сторону
   * ответить на этот вопрос явно, а не забыть про него.
   */
  placementsChecked: boolean
  /** Состояние точек встраивания (см. `checkPlacements`). */
  placements: readonly PlacementCheck[]
  /** Привязки, которых мы не регистрируем (см. `extraPlacements`). */
  extras?: readonly RegisteredPlacement[]
  /** Права администратора портала у текущего пользователя. */
  isAdmin?: boolean
}

/**
 * Один диагноз и одно действие.
 *
 * Порядок проверок — порядок лечения: пока не выданы права, разбираться с точками бессмысленно,
 * а пока установка не завершена — точки уже привязаны, но портал их всё равно не покажет.
 */
export function installVerdict(state: InstallState): InstallVerdict {
  const missing = [...state.missing]
  if (missing.length > 0) {
    return {
      level: 'error',
      title: `Приложению не выдано право: ${missing.join(', ')}`,
      hint: state.isAdmin === false
        ? 'Права выдаёт администратор портала — попросите его открыть карточку приложения, отметить эти права и переустановить приложение.'
        : 'Откройте карточку приложения в портале, отметьте эти права и переустановите приложение: без права crm точка CRM-аналитики не регистрируется вообще.'
    }
  }

  if (state.appInstalled === false) {
    return {
      level: 'error',
      title: 'Портал считает приложение неустановленным',
      hint: 'Пока установка не завершена, портал не показывает пункты приложения — даже привязанные. Нажмите «Проверить снова»; если не меняется, откройте страницу установки из карточки приложения (кнопка «Переустановить»).'
    }
  }

  if (!state.placementsChecked) {
    return {
      level: 'warning',
      title: 'Не удалось проверить точки встройки',
      hint: 'Портал не ответил на запрос списка точек, поэтому сказать, зарегистрирован ли отчёт, нельзя. Нажмите «Проверить снова».'
    }
  }

  const absent = state.placements.filter(item => item.status === 'missing')
  if (absent.length > 0) {
    return {
      level: 'error',
      title: `Не зарегистрированы пункты: ${absent.map(item => item.title ?? item.code).join(', ')}`,
      hint: 'Нажмите «Перепривязать точки». Если не помогло — проверьте, что приложение локальное и ему выданы права crm и placement.'
    }
  }

  const extras = state.extras ?? []
  if (extras.length > 0) {
    return {
      level: 'warning',
      title: 'В портале остались лишние пункты приложения',
      hint: `Кроме двух наших отчётов портал помнит ещё ${extras.length}: ${extras.map(row => row.code).join(', ')}. Так бывает после обновления с прежней версии, где пункт был один. Нажмите «Перепривязать точки» — лишние снимутся.`
    }
  }

  const foreign = state.placements.filter(item => item.status === 'other-handler')
  if (foreign.length > 0) {
    return {
      level: 'warning',
      title: 'Точки привязаны на другой адрес приложения',
      // Пустую строку сюда приносит сам `parseRegisteredPlacements`: портал может вернуть запись
      // без адреса. Подставлять её в подсказку значит напечатать «открывает .» — поэтому берём
      // первый НЕПУСТОЙ адрес, а если такого нет, говорим словами.
      hint: `Пункт в портале есть, но открывает ${foreign.flatMap(item => item.foreignHandlers).find(url => url.trim() !== '') ?? 'другой адрес'}. Нажмите «Перепривязать точки», чтобы заменить адрес на текущий.`
    }
  }

  return {
    level: 'ok',
    title: 'Всё зарегистрировано — оба отчёта доступны в портале',
    hint: 'Пункты «Аналитика по лидам» и «Сделки по менеджерам» — раздел «CRM-аналитика», в левом меню раскройте «Приложения» (рядом с «Маркетплейс»). Меню кэшируется: если пунктов не видно, перезагрузите страницу портала целиком.'
  }
}
