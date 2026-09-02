<script setup lang="ts">
import { PLACEMENTS, placementHandlerUrl } from '~/config/b24'

/**
 * Обработчик установки приложения.
 *
 * Порядок шагов важен: сначала `placement.bind` для каждой точки, потом `installFinish`. Пока
 * установка не завершена, пункт приложения в интерфейсе портала не показывается вовсе — то есть
 * привязать точки ПОСЛЕ завершения означало бы, что первый вход человека приходится на портал без
 * нашего пункта.
 */
const b24 = useB24()
const config = useRuntimeConfig()

type Step = { code: string, ok: boolean, error?: string }

const steps = ref<Step[]>([])
const state = ref<'idle' | 'running' | 'done' | 'failed'>('idle')
const fatal = ref<string | undefined>(undefined)

const handler = computed(() => placementHandlerUrl(config.public.siteUrl))

useHead({ title: 'Установка' })

async function install() {
  state.value = 'running'
  fatal.value = undefined
  steps.value = []

  await b24.init()
  if (!b24.isInit()) {
    // Вне фрейма ставить нечего: страница открыта напрямую.
    fatal.value = 'Страница установки открыта вне портала Битрикс24.'
    state.value = 'failed'
    return
  }

  // ⚠ Без абсолютного адреса регистрировать точки нельзя: относительный `placement.bind` не
  // примет, а пустой дал бы пункт, открывающий пустоту. Лучше явная ошибка сейчас.
  if (!handler.value) {
    fatal.value = 'Не задан публичный адрес приложения (NUXT_PUBLIC_SITE_URL) — точки встройки зарегистрировать нельзя.'
    state.value = 'failed'
    return
  }

  const frame = b24.getOrThrow()

  for (const placement of PLACEMENTS) {
    try {
      const response = await frame.callMethod('placement.bind', {
        PLACEMENT: placement.code,
        HANDLER: handler.value,
        TITLE: placement.title,
        LANG_ALL: {
          ru: { TITLE: placement.title },
          en: { TITLE: 'Lead analytics' }
        }
      })
      const data = response.getData() as { result?: unknown, error?: string } | undefined
      steps.value.push({ code: placement.code, ok: Boolean(data?.result) })
    } catch (e) {
      steps.value.push({ code: placement.code, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  try {
    await frame.installFinish()
    state.value = steps.value.every(s => s.ok) ? 'done' : 'failed'
  } catch (e) {
    fatal.value = e instanceof Error ? e.message : String(e)
    state.value = 'failed'
  }
}

onMounted(install)
</script>

<template>
  <main class="mx-auto max-w-xl space-y-4 p-8">
    <h1 class="text-xl font-bold">
      Установка приложения
    </h1>

    <p
      v-if="state === 'running'"
      class="text-sm opacity-70"
    >
      Регистрируем отчёт в разделе CRM-аналитики…
    </p>

    <B24Alert
      v-if="state === 'done'"
      color="air-primary-success"
      title="Готово"
      description="Отчёт доступен в разделе «CRM-аналитика» → «Приложения» рядом с пунктом «Маркетплейс». Если пункт не появился — перезагрузите страницу портала."
    />

    <B24Alert
      v-if="fatal"
      color="air-primary-alert"
      title="Установка не завершена"
      :description="fatal"
    />

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

    <B24Button
      v-if="state === 'failed'"
      color="air-primary"
      @click="install"
    >
      Повторить
    </B24Button>

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
            Права:
          </dt> <dd class="inline">
            {{ b24.getRequiredRights().join(', ') }}
          </dd>
        </div>
      </dl>
    </details>
  </main>
</template>
