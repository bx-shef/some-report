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

    <PeriodPicker
      :period="period"
      :today="today"
      @update:period="emit('update:period', $event)"
    />
  </div>
</template>
