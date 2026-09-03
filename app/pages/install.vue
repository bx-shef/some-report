<script setup lang="ts">
import { B24_REQUIRED_SCOPES, PLACEMENTS, placementHandlerUrl, portalAnalyticsUrl } from '~/config/b24'
import {
  checkPlacements,
  installVerdict,
  missingScopes,
  parseRegisteredPlacements,
  type InstallVerdict,
  type PlacementCheck
} from '~/utils/installDiagnostics'

/**
 * Установка приложения и проверка того, что портал её действительно принял.
 *
 * Порядок шагов важен: сначала `placement.bind` для каждой точки, потом `installFinish`. Пока
 * установка не завершена, пункт приложения в интерфейсе портала не показывается вовсе — то есть
 * привязать точки ПОСЛЕ завершения означало бы, что первый вход человека приходится на портал без
 * нашего пункта.
 *
 * ⚠ Третий шаг — ПРОВЕРКА, и он появился не от любви к диагностике. Страница показывала «Готово»
 * по ответу `placement.bind`, то есть по факту «портал не возразил на просьбу». Заказчик прошёл
 * установку, увидел зелёное «Готово» и не нашёл отчёт в портале. Поэтому теперь после установки
 * спрашиваем портал, что у него получилось: `app.info` (завершена ли установка), `scope` (какие
 * права выданы) и `placement.get` (какие точки и на какой адрес привязаны). Разбор ответов —
 * в `app/utils/installDiagnostics.ts`, здесь только вызовы и отрисовка.
 */
const b24 = useB24()
const config = useRuntimeConfig()

type Step = { code: string, ok: boolean, error?: string }

const steps = ref<Step[]>([])
const state = ref<'idle' | 'running' | 'checking' | 'done' | 'failed'>('idle')
const fatal = ref<string | undefined>(undefined)
const verdict = ref<InstallVerdict | undefined>(undefined)
const placementChecks = ref<PlacementCheck[]>([])
const grantedScopes = ref<string[]>([])
const appInstalled = ref<boolean | undefined>(undefined)
const isAdmin = ref<boolean | undefined>(undefined)

const handler = computed(() => placementHandlerUrl(config.public.siteUrl))
const analyticsUrl = computed(() => portalAnalyticsUrl(b24.targetOrigin()))

useHead({ title: 'Установка' })

/**
 * Вызов REST с разбором ответа в рантайме.
 *
 * ⚠ Форму ответа проверяем, а не приводим через `as`: слепое приведение ничем не лучше `any` —
 * при смене формата SDK TypeScript промолчит, а диагностика начнёт уверенно показывать неправду.
 */
async function callResult(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const response = await b24.getOrThrow().callMethod(method, params)
  const data: unknown = response.getData()
  if (typeof data !== 'object' || data === null) return undefined
  return (data as { result?: unknown }).result
}

/** Регистрация точек встраивания. Ошибку каждой показываем отдельно: лечатся они по-разному. */
async function bindPlacements(): Promise<void> {
  steps.value = []
  for (const placement of PLACEMENTS) {
    try {
      const result = await callResult('placement.bind', {
        PLACEMENT: placement.code,
        HANDLER: handler.value,
        TITLE: placement.title,
        LANG_ALL: {
          ru: { TITLE: placement.title },
          en: { TITLE: 'Lead analytics' }
        }
      })
      steps.value.push({ code: placement.code, ok: Boolean(result) })
    } catch (e) {
      steps.value.push({ code: placement.code, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
}

/**
 * Спрашиваем портал, что у него получилось.
 *
 * Каждый вызов в своём `try`: `app.info` может быть недоступен, а `placement.get` без права
 * `placement` ответит ошибкой — и это само по себе ценный факт, который не должен обрушить
 * остальные проверки.
 */
async function verify(): Promise<void> {
  state.value = 'checking'

  try {
    isAdmin.value = b24.getOrThrow().auth.isAdmin
  } catch { /* не смогли узнать — диагноз обойдётся без этого */ }

  try {
    const info = await callResult('app.info')
    appInstalled.value = typeof info === 'object' && info !== null
      ? Boolean((info as { INSTALLED?: unknown }).INSTALLED)
      : undefined
  } catch { appInstalled.value = undefined }

  try {
    const scopes = await callResult('scope')
    grantedScopes.value = Array.isArray(scopes) ? scopes.filter(s => typeof s === 'string') : []
  } catch { grantedScopes.value = [] }

  try {
    placementChecks.value = checkPlacements(
      PLACEMENTS.map(p => p.code),
      parseRegisteredPlacements(await callResult('placement.get')),
      handler.value ?? ''
    )
  } catch {
    placementChecks.value = []
  }

  verdict.value = installVerdict({
    appInstalled: appInstalled.value,
    // Пустой ответ `scope` означает «спросить не удалось», а не «прав нет»: не пугаем зря.
    missing: grantedScopes.value.length > 0 ? missingScopes(grantedScopes.value, B24_REQUIRED_SCOPES) : [],
    placements: placementChecks.value,
    isAdmin: isAdmin.value
  })

  state.value = verdict.value.level === 'error' ? 'failed' : 'done'
  await b24.fitWindow()
}

/** Подготовка: инициализация SDK и проверки, без которых устанавливать нечего. */
async function ready(): Promise<boolean> {
  fatal.value = undefined
  await b24.init()
  if (!b24.isInit()) {
    // Вне фрейма ставить нечего: страница открыта напрямую.
    fatal.value = 'Страница установки открыта вне портала Битрикс24.'
    state.value = 'failed'
    return false
  }
  // ⚠ Без абсолютного адреса регистрировать точки нельзя: относительный `placement.bind` не
  // примет, а пустой дал бы пункт, открывающий пустоту. Лучше явная ошибка сейчас.
  if (!handler.value) {
    fatal.value = 'Не задан публичный адрес приложения (NUXT_PUBLIC_SITE_URL) — точки встройки зарегистрировать нельзя.'
    state.value = 'failed'
    return false
  }
  return true
}

async function install() {
  state.value = 'running'
  if (!await ready()) return

  await bindPlacements()

  try {
    await b24.getOrThrow().installFinish()
  } catch (e) {
    // Не обрываемся: если установка уже была завершена раньше, повторный вызов ругается, а точки
    // при этом привязаны. Что на самом деле вышло — покажет проверка.
    fatal.value = `installFinish: ${e instanceof Error ? e.message : String(e)}`
  }

  await verify()
}

/** Только проверка, без установки — кнопка «Проверить снова» после перезагрузки портала. */
async function recheck() {
  state.value = 'checking'
  if (!await ready()) return
  await verify()
}

/**
 * Перепривязка точек: снимаем ВСЕ свои привязки и ставим заново.
 *
 * ⚠ Именно со снятием. Точка, привязанная на прошлый адрес приложения (переезд домена), даёт
 * пункт в меню, который открывает пустоту, — и повторный `bind` рядом с ней оставил бы в меню
 * два одинаковых пункта, один из которых сломан.
 */
async function rebind() {
  state.value = 'running'
  if (!await ready()) return
  for (const placement of PLACEMENTS) {
    try {
      await callResult('placement.unbind', { PLACEMENT: placement.code })
    } catch { /* нечего снимать — тем лучше */ }
  }
  await bindPlacements()
  await verify()
}

onMounted(install)
</script>

<template>
  <main class="mx-auto max-w-2xl space-y-4 p-8">
    <h1 class="text-xl font-bold">
      Установка приложения
    </h1>

    <p
      v-if="state === 'running'"
      class="text-sm opacity-70"
    >
      Регистрируем отчёт в разделе CRM-аналитики…
    </p>
    <p
      v-else-if="state === 'checking'"
      class="text-sm opacity-70"
    >
      Спрашиваем портал, что получилось…
    </p>

    <B24Alert
      v-if="verdict"
      :color="verdict.level === 'ok' ? 'air-primary-success' : verdict.level === 'warning' ? 'air-primary-warning' : 'air-primary-alert'"
      :title="verdict.title"
      :description="verdict.hint"
    />

    <B24Alert
      v-if="fatal"
      color="air-primary-alert"
      title="Установка не завершена"
      :description="fatal"
    />

    <!-- То, за чем сюда и приходят: где именно открыть отчёт. Путей ДВА — раздел аналитики
         находят не с первого раза, а плитка приложения не зависит от точек встройки. -->
    <section class="space-y-1 text-sm">
      <h2 class="font-semibold">
        Где открыть отчёт
      </h2>
      <ol class="list-decimal space-y-1 pl-5">
        <li>
          <b>Плитка приложения:</b> «Приложения» → «Аналитика по лидам». Открывает отчёт сразу и
          работает даже если пункт в аналитике не появился.
        </li>
        <li>
          <b>Пункт в CRM-аналитике:</b>
          <a
            v-if="analyticsUrl"
            :href="analyticsUrl"
            target="_blank"
            rel="noopener"
            class="underline"
          >{{ analyticsUrl }}</a>
          <span v-else>раздел «CRM-аналитика»</span>
          → в левом меню раскройте «Приложения» → «Аналитика по лидам», рядом с «Маркетплейс».
        </li>
      </ol>
    </section>

    <ul
      v-if="steps.length"
      class="space-y-2 text-sm"
    >
      <li
        v-for="step in steps"
        :key="step.code"
        class="flex items-start gap-2"
      >
        <span :class="step.ok ? 'text-green-600' : 'text-red-600'">{{ step.ok ? '✓' : '✕' }}</span>
        <span>
          <code>{{ step.code }}</code>
          <span
            v-if="step.error"
            class="ml-2 opacity-70"
          >{{ step.error }}</span>
        </span>
      </li>
    </ul>

    <div class="flex flex-wrap gap-2">
      <B24Button
        color="air-primary"
        :disabled="state === 'running' || state === 'checking'"
        @click="recheck"
      >
        Проверить снова
      </B24Button>
      <B24Button
        color="air-secondary"
        :disabled="state === 'running' || state === 'checking'"
        @click="rebind"
      >
        Перепривязать точки
      </B24Button>
    </div>

    <details class="text-sm opacity-70">
      <summary class="cursor-pointer">
        Диагностика
      </summary>
      <dl class="mt-2 space-y-1">
        <div>
          <dt class="inline font-semibold">
            Адрес обработчика:
          </dt> <dd class="inline">
            {{ handler ?? 'не задан' }}
          </dd>
        </div>
        <div>
          <dt class="inline font-semibold">
            Портал:
          </dt> <dd class="inline">
            {{ b24.targetOrigin() }}
          </dd>
        </div>
        <div>
          <dt class="inline font-semibold">
            Установка завершена:
          </dt> <dd class="inline">
            {{ appInstalled === undefined ? 'не удалось узнать' : appInstalled ? 'да' : 'нет' }}
          </dd>
        </div>
        <div>
          <dt class="inline font-semibold">
            Права нужны:
          </dt> <dd class="inline">
            {{ b24.getRequiredRights().join(', ') }}
          </dd>
        </div>
        <div>
          <dt class="inline font-semibold">
            Права выданы:
          </dt> <dd class="inline">
            {{ grantedScopes.length ? grantedScopes.join(', ') : 'не удалось узнать' }}
          </dd>
        </div>
        <div>
          <dt class="inline font-semibold">
            Администратор портала:
          </dt> <dd class="inline">
            {{ isAdmin === undefined ? 'не удалось узнать' : isAdmin ? 'да' : 'нет' }}
          </dd>
        </div>
      </dl>

      <ul
        v-if="placementChecks.length"
        class="mt-2 space-y-1"
      >
        <li
          v-for="check in placementChecks"
          :key="check.code"
        >
          <code>{{ check.code }}</code> —
          <template v-if="check.status === 'ok'">
            привязана на наш адрес
          </template>
          <template v-else-if="check.status === 'missing'">
            не зарегистрирована
          </template>
          <template v-else>
            привязана на другой адрес: {{ check.foreignHandlers.join(', ') }}
          </template>
        </li>
      </ul>
    </details>
  </main>
</template>
