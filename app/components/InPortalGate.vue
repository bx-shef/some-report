<script setup lang="ts">
import { isPreviewQuery, portalGateState } from '~/utils/inPortalGate'

/**
 * Общая заглушка для страниц, которые работают только внутри Битрикс24.
 *
 * Снаружи портала у отчёта нет фрейм-токена, а значит нет и данных. Показать пустой отчёт нельзя:
 * пустая таблица читается как «продаж не было», а это неправда.
 */
const b24 = useB24()
const route = useRoute()

const resolved = ref(false)
const preview = computed(() => isPreviewQuery(route.query.preview))
const state = computed(() => portalGateState({
  resolved: resolved.value,
  inPortal: b24.isInit(),
  preview: preview.value
}))

onMounted(async () => {
  await b24.init()
  resolved.value = true
})
</script>

<template>
  <div
    v-if="state === 'checking'"
    class="p-8 text-center text-sm opacity-60"
  >
    Проверяем подключение к порталу…
  </div>

  <div
    v-else-if="state === 'outside'"
    class="mx-auto max-w-xl p-8"
  >
    <B24Alert
      color="air-primary-warning"
      title="Страница работает только внутри Битрикс24"
      description="Отчёт читает лиды и сделки вашего портала. Снаружи портала у него нет доступа к данным, поэтому показывать здесь нечего. Откройте раздел «CRM-аналитика» → «Приложения» и выберите «Аналитика по лидам»."
    />
  </div>

  <slot v-else />
</template>
