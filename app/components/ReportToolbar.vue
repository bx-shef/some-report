<script setup lang="ts">
import type { ReportPeriod } from '~/types/report'
import { formatDate } from '~/utils/format'

/**
 * Панель отчёта: период.
 *
 * ⚠ Переключателя знаменателя конверсий здесь больше нет — и это решение владельца от
 * 2026-09-04, а не упрощение. Пока клиент сверял отчёт с макетом, переключатель показывал
 * разницу между «все лиды» и «лиды без брака»; ТЗ от 04.09 закрепило второе, и два ответа на
 * один вопрос рядом с заголовком подрывали бы доверие к числу. Знаменатель — `docs/METRICS.md`.
 */
const props = defineProps<{
  /** Выбранный период — подсвечивает интервал и уходит в запрос. */
  period: ReportPeriod
  /**
   * Период, по которому ПОСЧИТАНЫ числа на экране. Подпись строится по нему, а не по выбранному:
   * иначе при неудачной загрузке заголовок показывал бы новый период над числами старого.
   */
  appliedPeriod?: ReportPeriod
  isDemo: boolean
  /** «Сегодня» приходит снаружи: интервалы считаются от него, и в тестах он должен быть задан. */
  today: Date
}>()

const emit = defineEmits<{
  'update:period': [ReportPeriod]
}>()

const periodText = computed(() => {
  const shown = props.appliedPeriod ?? props.period
  return `${formatDate(shown.from)} — ${formatDate(shown.to)}`
})

/**
 * Выбор периода — общий композабл: те же кнопки и та же проверка, что во второй панели.
 * Здесь остаётся только то, что у панелей действительно разное: период приходит пропом и
 * уходит наружу событием.
 */
const {
  presets, isPresetActive, isCustomActive, customFrom, customTo, problem, customProblem, pickPreset
} = usePeriodPicker({
  period: () => props.period,
  today: () => props.today,
  apply: bounds => emit('update:period', bounds)
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="mr-auto text-xl font-bold">
        Аналитика по лидам
      </h1>

      <!-- Кнопки экспорта — от страницы: панель периода про них не знает. -->
      <slot name="actions" />

      <B24Badge
        v-if="isDemo"
        color="air-primary-warning"
        label="Демо-данные"
      />

      <div class="rounded-lg border border-[color:var(--chart-track)] px-3 py-1.5 text-sm">
        {{ periodText }}
      </div>
    </div>

    <!-- В PDF-снимок кнопки периода не попадают (`data-export-exclude`): период там — подписью. -->
    <div
      role="group"
      aria-label="Период отчёта"
      class="flex flex-wrap items-center gap-2"
      data-export-exclude
    >
      <span class="text-xs opacity-60">Период:</span>
      <button
        v-for="preset in presets"
        :key="preset.id"
        type="button"
        class="rounded-lg border border-[color:var(--chart-track)] px-2.5 py-1 text-sm transition-colors"
        :class="isPresetActive(preset.id)
          ? 'bg-[color:var(--chart-1)] text-white'
          : 'hover:bg-[color:var(--chart-track)]'"
        :aria-pressed="isPresetActive(preset.id)"
        @click="pickPreset(preset.id)"
      >
        {{ preset.label }}
      </button>
    </div>

    <B24Alert
      v-if="problem"
      color="air-primary-alert"
      title="Период выбран неверно"
      :description="problem"
    />

    <div
      v-if="isCustomActive"
      class="space-y-2"
      data-export-exclude
    >
      <PeriodField
        v-model:from="customFrom"
        v-model:to="customTo"
        :today="today"
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
