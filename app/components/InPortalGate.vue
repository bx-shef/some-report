<script setup lang="ts">
import { isPreviewQuery, portalGateState } from '~/utils/inPortalGate'

/**
 * Общая заглушка для страниц, которые работают только внутри Битрикс24.
 *
 * Снаружи портала у отчёта нет фрейм-токена, а значит нет и данных. Показать пустой отчёт нельзя:
 * пустая таблица читается как «продаж не было», а это неправда.
 */
const emit = defineEmits<{
  /**
   * Гейт впустил и содержимое отрисовано.
   *
   * ⚠ Нужен потому, что страница НЕ МОЖЕТ узнать этот момент сама: отчёт живёт в слоте гейта и
   * появляется в DOM только после того, как гейт закончит свою проверку. Страница, зовущая
   * `fitWindow()` в своём `onMounted`, замеряет высоту заглушки «Проверяем подключение…» — и
   * портал оставляет фрейм высотой в одну строку.
   */
  ready: []
}>()

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

// `nextTick` обязателен: на момент смены состояния слот ещё не в DOM, и замерять нечего.
watch(state, async (value) => {
  if (value !== 'ok') return
  await nextTick()
  emit('ready')
}, { immediate: true })
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
