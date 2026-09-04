<script setup lang="ts">
import type { ConversionBase, ReportPeriod } from '~/types/report'
import { formatDate } from '~/utils/format'
import { PERIOD_PRESETS, matchPreset, resolvePreset, validatePeriod, type PeriodPresetId } from '~/utils/period'

/**
 * Панель отчёта: период и знаменатель конверсий.
 *
 * ⚠ Переключатель базы — не настройка «на всякий случай». ТЗ и согласованный макет считают
 * конверсии по-разному (см. `docs/METRICS.md`), и на одних и тех же данных отчёт даёт 100 % или
 * 80 %. Пока клиент сверяет отчёт с макетом, переключатель делает разницу видимой ровно там, где
 * на неё смотрят.
 */
const props = defineProps<{
  conversionBase: ConversionBase
  period: ReportPeriod
  isDemo: boolean
  /** «Сегодня» приходит снаружи: интервалы считаются от него, и в тестах он должен быть задан. */
  today: Date
}>()

const emit = defineEmits<{
  'update:conversionBase': [ConversionBase]
  'update:period': [ReportPeriod]
}>()

const BASES: Array<{ value: ConversionBase, label: string, hint: string }> = [
  { value: 'quality-leads', label: 'Качественные лиды', hint: 'Лиды − Брак. Так написано в ТЗ' },
  { value: 'all-leads', label: 'Все лиды', hint: 'Весь поток. Так посчитаны цифры на макете' }
]

const periodText = computed(() => `${formatDate(props.period.from)} — ${formatDate(props.period.to)}`)

/** Какой готовый интервал сейчас выбран. Ручной ввод «01.09 — 30.09» подсветит «Текущий месяц». */
const activePreset = computed(() => matchPreset(props.period, props.today))

/** Произвольный интервал разворачивает поле с календарём. Готовый — прячет: место дорого. */
const customOpen = ref(false)
const customFrom = ref(props.period.from)
const customTo = ref(props.period.to)

watch(() => props.period, (period) => {
  customFrom.value = period.from
  customTo.value = period.to
})

function pickPreset(id: PeriodPresetId): void {
  if (id === 'custom') {
    customOpen.value = true
    return
  }
  customOpen.value = false
  const bounds = resolvePreset(id, props.today)
  if (bounds) emit('update:period', bounds)
}

/**
 * Проблема выбранного вручную периода.
 *
 * ⚠ Проверяем ДО запроса. Перевёрнутый период REST принимает без ошибки и возвращает пустой
 * список — отчёт показал бы нули, неотличимые от «за период ничего не было», и человек искал бы
 * ошибку в CRM, а она у него на экране.
 */
const customProblem = computed(() => {
  if (!customFrom.value || !customTo.value) return undefined
  return validatePeriod({ from: customFrom.value, to: customTo.value })
})

// Обе границы выбраны и период годный — применяем. Одна граница — человек ещё выбирает.
watch([customFrom, customTo], () => {
  if (!customOpen.value) return
  if (!customFrom.value || !customTo.value || customProblem.value) return
  if (customFrom.value === props.period.from && customTo.value === props.period.to) return
  emit('update:period', { from: customFrom.value, to: customTo.value })
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="mr-auto text-xl font-bold">
        Аналитика по лидам
      </h1>

      <B24Badge
        v-if="isDemo"
        color="air-primary-warning"
        label="Демо-данные"
      />

      <div class="rounded-lg border border-[color:var(--chart-track)] px-3 py-1.5 text-sm">
        {{ periodText }}
      </div>

      <fieldset class="flex items-center gap-2">
        <legend class="sr-only">
          Знаменатель конверсий
        </legend>
        <span class="text-xs opacity-60">Конверсии считать от:</span>
        <div class="flex overflow-hidden rounded-lg border border-[color:var(--chart-track)]">
          <button
            v-for="base in BASES"
            :key="base.value"
            type="button"
            class="px-3 py-1.5 text-sm transition-colors"
            :class="base.value === conversionBase
              ? 'bg-[color:var(--chart-1)] text-white'
              : 'hover:bg-[color:var(--chart-track)]'"
            :title="base.hint"
            :aria-pressed="base.value === conversionBase"
            @click="emit('update:conversionBase', base.value)"
          >
            {{ base.label }}
          </button>
        </div>
      </fieldset>
    </div>

    <div
      role="group"
      aria-label="Период отчёта"
      class="flex flex-wrap items-center gap-2"
    >
      <span class="text-xs opacity-60">Период:</span>
      <button
        v-for="preset in PERIOD_PRESETS"
        :key="preset.id"
        type="button"
        class="rounded-lg border border-[color:var(--chart-track)] px-2.5 py-1 text-sm transition-colors"
        :class="(preset.id === 'custom' ? customOpen || activePreset === 'custom' : preset.id === activePreset && !customOpen)
          ? 'bg-[color:var(--chart-1)] text-white'
          : 'hover:bg-[color:var(--chart-track)]'"
        :aria-pressed="preset.id === 'custom' ? customOpen || activePreset === 'custom' : preset.id === activePreset && !customOpen"
        @click="pickPreset(preset.id)"
      >
        {{ preset.label }}
      </button>
    </div>

    <div
      v-if="customOpen || activePreset === 'custom'"
      class="space-y-2"
    >
      <PeriodField
        v-model:from="customFrom"
        v-model:to="customTo"
      />
      <B24Alert
        v-if="customProblem"
        color="air-primary-alert"
        title="Период выбран неверно"
        :description="customProblem.message"
      />
    </div>
  </div>
</template>
