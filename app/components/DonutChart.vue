<script setup lang="ts">
import { DEFAULT_DONUT, donutSegments } from '~/utils/donut'

/**
 * Кольцевая диаграмма на голом SVG.
 *
 * Идентичность сектора НИКОГДА не держится на одном цвете: рядом обязательна легенда с числами
 * (слот `legend`), а под блоком — полная таблица. Это не украшение, а условие, при котором палитра
 * признана годной: два её цвета в светлой теме идут ниже 3:1 к фону.
 */
const props = withDefaults(defineProps<{
  items: Array<{ key: string, label: string, value: number, color: string }>
  /** Крупное число в центре кольца. */
  centerValue?: string
  centerLabel?: string
  size?: number
}>(), {
  centerValue: undefined,
  centerLabel: undefined,
  size: 160
})

const segments = computed(() =>
  donutSegments(props.items.map(i => ({ key: i.key, value: i.value })), DEFAULT_DONUT)
)
const colorByKey = computed(() => Object.fromEntries(props.items.map(i => [i.key, i.color])))
const labelByKey = computed(() => Object.fromEntries(props.items.map(i => [i.key, i.label])))
</script>

<template>
  <div
    class="relative shrink-0"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <svg
      viewBox="0 0 100 100"
      :width="size"
      :height="size"
      role="img"
      aria-label="Разбивка по причинам"
    >
      <!-- Пустое кольцо вместо «нет данных» текстом: блок сохраняет размер, и таблица под ним
           не прыгает при смене периода. -->
      <circle
        v-if="!segments.length"
        cx="50"
        cy="50"
        :r="DEFAULT_DONUT.radius - DEFAULT_DONUT.thickness / 2"
        fill="none"
        :stroke-width="DEFAULT_DONUT.thickness"
        stroke="var(--chart-track)"
      />
      <path
        v-for="segment in segments"
        :key="segment.key"
        :d="segment.path"
        :fill="colorByKey[segment.key]"
      >
        <title>{{ labelByKey[segment.key] }}</title>
      </path>
    </svg>
    <div
      v-if="centerValue"
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
    >
      <span class="text-2xl font-semibold leading-none">{{ centerValue }}</span>
      <span
        v-if="centerLabel"
        class="mt-1 text-xs opacity-60"
      >{{ centerLabel }}</span>
    </div>
  </div>
</template>
