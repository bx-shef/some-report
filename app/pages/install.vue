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
const installFinishError = ref<string | undefined>(undefined)
const unbindErrors = ref<string[]>([])
const verdict = ref<InstallVerdict | undefined>(undefined)
const placementChecks = ref<PlacementCheck[]>([])
const placementsChecked = ref(false)
/** `undefined` — спросить не удалось; `[]` — спросили, и прав нет. Это разные факты. */
const grantedScopes = ref<string[] | undefined>(undefined)
const appInstalled = ref<boolean | undefined>(undefined)
const isAdmin = ref<boolean | undefined>(undefined)
/** Перепривязка снимает живые привязки, поэтому спрашиваем подтверждение вторым нажатием. */
const rebindArmed = ref(false)

const handler = computed(() => placementHandlerUrl(config.public.siteUrl))

/**
 * Адрес раздела CRM-аналитики портала.
 *
 * ⚠ `b24.isInit()` здесь обязателен, и не для красоты. `targetOrigin()` читает модульный
 * синглтон напрямую, мимо реактивности; `computed` только над ним не имел бы ни одной
 * зависимости, вычислился бы один раз на первом рендере — ДО того как `onMounted` запустит
 * `init()` — и навсегда застрял бы на `null`. Ссылка «Где открыть отчёт» не показалась бы
 * никогда. `isInit()` читает настоящий `ref`, и пересчёт происходит.
 */
const analyticsUrl = computed(() => (b24.isInit() ? portalAnalyticsUrl(b24.targetOrigin()) : null))

const busy = computed(() => state.value === 'running' || state.value === 'checking')

const verdictColor = computed(() => {
  if (verdict.value?.level === 'ok') return 'air-primary-success'
  if (verdict.value?.level === 'warning') return 'air-primary-warning'
  return 'air-primary-alert'
})

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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
      steps.value.push({ code: placement.code, ok: false, error: describe(e) })
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
    grantedScopes.value = Array.isArray(scopes) ? scopes.filter(s => typeof s === 'string') : undefined
  } catch { grantedScopes.value = undefined }

  try {
    placementChecks.value = checkPlacements(
      PLACEMENTS.map(p => p.code),
      parseRegisteredPlacements(await callResult('placement.get')),
      handler.value ?? ''
    )
    placementsChecked.value = true
  } catch {
    // ⚠ Именно ФЛАГ, а не пустой список: пустой список означал бы «точек нет» и увёл бы вердикт
    // в зелёное «всё зарегистрировано» ровно тогда, когда мы не проверили ничего.
    placementChecks.value = []
    placementsChecked.value = false
  }

  verdict.value = installVerdict({
    appInstalled: appInstalled.value,
    missing: grantedScopes.value ? missingScopes(grantedScopes.value, B24_REQUIRED_SCOPES) : [],
    placementsChecked: placementsChecked.value,
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

/** Сброс перед новым прогоном: старый вердикт не должен висеть поверх нового хода работ. */
function resetDiagnosis(): void {
  verdict.value = undefined
  placementChecks.value = []
  placementsChecked.value = false
  unbindErrors.value = []
  installFinishError.value = undefined
}

async function install() {
  if (busy.value) return
  state.value = 'running'
  resetDiagnosis()
  if (!await ready()) return

  await bindPlacements()

  try {
    await b24.getOrThrow().installFinish()
  } catch (e) {
    // Не обрываемся: если установка уже была завершена раньше (обычное дело при повторном
    // открытии страницы), портал ругается, а точки при этом привязаны. Что вышло на самом деле,
    // покажет проверка — поэтому и показываем эту строку только когда вердикт НЕ зелёный.
    installFinishError.value = describe(e)
  }

  await verify()
}

/** Только проверка, без установки — кнопка «Проверить снова» после перезагрузки портала. */
async function recheck() {
  if (busy.value) return
  state.value = 'checking'
  resetDiagnosis()
  if (!await ready()) return
  await verify()
}

/**
 * Перепривязка точек: снимаем ВСЕ свои привязки и ставим заново.
 *
 * ⚠ Именно со снятием. Точка, привязанная на прошлый адрес приложения (переезд домена), даёт
 * пункт в меню, который открывает пустоту, — и повторный `bind` рядом с ней оставил бы в меню
 * два одинаковых пункта, один из которых сломан.
 *
 * ⚠ И именно поэтому кнопка двухшаговая: операция трогает регистрацию, видную ВСЕМУ порталу, а
 * лежит она рядом с безобидной «Проверить снова», в том числе когда всё уже исправно.
 */
async function rebind() {
  if (busy.value) return
  if (!rebindArmed.value) {
    rebindArmed.value = true
    return
  }
  rebindArmed.value = false
  state.value = 'running'
  resetDiagnosis()
  if (!await ready()) return

  for (const placement of PLACEMENTS) {
    try {
      await callResult('placement.unbind', { PLACEMENT: placement.code })
    } catch (e) {
      // ⚠ Не «нечего снимать — тем лучше»: сюда же приходят лимит запросов и сетевой сбой. При
      // них старая привязка ОСТАЛАСЬ, а следом мы поставим новую — и получим в меню два пункта,
      // один из которых открывает пустоту. Молчать об этом нельзя.
      unbindErrors.value.push(`${placement.code}: ${describe(e)}`)
    }
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
      :color="verdictColor"
      :title="verdict.title"
      :description="verdict.hint"
    />

    <B24Alert
      v-if="fatal"
      color="air-primary-alert"
      title="Установка не завершена"
      :description="fatal"
    />

    <!-- Снять старую привязку не удалось: в меню портала могли остаться два пункта. -->
    <B24Alert
      v-if="unbindErrors.length"
      color="air-primary-warning"
      title="Старые привязки сняты не полностью"
      :description="`В меню портала могли остаться лишние пункты. ${unbindErrors.join('; ')}`"
    />

    <!-- Показываем только когда вердикт не зелёный: при исправной установке повторный
         installFinish ругается всегда, и красная плашка под зелёной сбивала бы с толку. -->
    <B24Alert
      v-if="installFinishError && verdict && verdict.level !== 'ok'"
      color="air-primary-warning"
      title="Портал не принял завершение установки"
      :description="installFinishError"
    />

    <!-- То, за чем сюда и приходят: где именно открыть отчёты. Путей ДВА — раздел аналитики
         находят не с первого раза, а плитка приложения не зависит от точек встройки. -->
    <section class="space-y-1 text-sm">
      <h2 class="font-semibold">
        Где открыть отчёты
      </h2>
      <ol class="list-decimal space-y-1 pl-5">
        <li>
          <b>Плитка приложения:</b> «Приложения» → «{{ PLACEMENTS[0].title }}». Открывает страницу
          выбора отчёта и работает даже если пункт в аналитике не появился.
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
          → в левом меню раскройте «Приложения» → «{{ PLACEMENTS[0].title }}», рядом с «Маркетплейс».
          Оттуда открывается выбор отчёта: «Аналитика по лидам» и «Сделки по менеджерам».
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

    <div class="flex flex-wrap items-center gap-2">
      <B24Button
        color="air-primary"
        :disabled="busy"
        @click="recheck"
      >
        Проверить снова
      </B24Button>
      <B24Button
        :color="rebindArmed ? 'air-primary-alert' : 'air-secondary'"
        :disabled="busy || isAdmin === false"
        @click="rebind"
      >
        {{ rebindArmed ? 'Точно перепривязать?' : 'Перепривязать точки' }}
      </B24Button>
      <span
        v-if="rebindArmed"
        class="text-sm opacity-70"
      >Снимет текущие привязки во всём портале и поставит заново.</span>
      <span
        v-else-if="isAdmin === false"
        class="text-sm opacity-70"
      >Перепривязка доступна только администратору портала.</span>
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
            {{ grantedScopes === undefined ? 'не удалось узнать' : grantedScopes.join(', ') || 'ни одного' }}
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

      <p
        v-if="!placementsChecked && state !== 'idle'"
        class="mt-2"
      >
        Точки встройки: спросить портал не удалось.
      </p>
      <ul
        v-else-if="placementChecks.length"
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
