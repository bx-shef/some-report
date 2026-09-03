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
 * Состояние одной ожидаемой точки:
 * - `ok` — привязана на наш адрес;
 * - `other-handler` — привязана, но на другой адрес (переезд домена, старая установка);
 * - `missing` — не привязана вовсе.
 */
export type PlacementStatus = 'ok' | 'other-handler' | 'missing'

export interface PlacementCheck {
  code: string
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

/** Состояние каждой ожидаемой точки против того, что реально зарегистрировано в портале. */
export function checkPlacements(
  expected: readonly string[],
  registered: readonly RegisteredPlacement[],
  ourHandler: string
): PlacementCheck[] {
  const ours = normalizeHandlerUrl(ourHandler)
  return expected.map((code) => {
    const rows = registered.filter(row => row.code === code)
    if (rows.length === 0) return { code, status: 'missing', foreignHandlers: [] }
    const foreignHandlers = rows
      .filter(row => normalizeHandlerUrl(row.handler) !== ours)
      .map(row => row.handler)
    // Наша привязка есть — точка рабочая, даже если рядом висит чужая.
    if (foreignHandlers.length < rows.length) return { code, status: 'ok', foreignHandlers }
    return { code, status: 'other-handler', foreignHandlers }
  })
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
      title: `Не зарегистрированы точки встройки: ${absent.map(item => item.code).join(', ')}`,
      hint: 'Нажмите «Перепривязать точки». Если не помогло — проверьте, что приложение локальное и ему выданы права crm и placement.'
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
    title: 'Всё зарегистрировано — отчёт доступен в портале',
    hint: 'Пункт «Аналитика по лидам» — раздел «CRM-аналитика», в левом меню раскройте «Приложения» (рядом с «Маркетплейс»). Пункт кэшируется: если его не видно, перезагрузите страницу портала целиком.'
  }
}
