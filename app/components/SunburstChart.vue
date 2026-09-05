<script setup lang="ts">
import { DEFAULT_SUNBURST, sunburstArcs, type SunburstNode } from '~/utils/sunburst'

/**
 * Многокольцевая диаграмма на голом SVG: внутреннее кольцо — корни, наружу — их дети.
 *
 * ⚠ Цвет ЗДЕСЬ НИКОГДА не единственный носитель смысла. У сектора есть подсказка с названием и
 * числом, рядом легенда корней, а под диаграммой — полная таблица с теми же числами. Это не
 * оговорка про доступность, а условие, при котором палитра `--chart-*` признана годной:
 * различимость соседей она проходит, а контраст к фону — не везде (`CLAUDE.md`, «Палитра»).
 *
 * ⚠ Кольца одной ветки — один тон разной насыщенности, как в прежнем отчёте заказчика: иначе
 * невозможно понять, чьи это дети. Насыщенность падает наружу, поэтому внешние кольца светлее.
 */
const props = withDefaults(defineProps<{
  nodes: SunburstNode[]
  /** Цвета корней по ключу — палитру задаёт вызывающая сторона, у диаграммы своей нет. */
  colorByRoot: Record<string, string>
  /** Крупное число в центре. */
  centerValue?: string
  centerLabel?: string
  size?: number
  /** Что именно разбито на секторы — читает скринридер. */
  ariaLabel?: string
}>(), {
  centerValue: undefined,
  centerLabel: undefined,
  size: 360,
  ariaLabel: 'Кольцевая диаграмма распределения'
})

const emit = defineEmits<{ pick: [string] }>()

const arcs = computed(() => sunburstArcs(props.nodes, DEFAULT_SUNBURST))

/**
 * Прозрачность кольца: 1 — внутреннее, дальше светлее.
 *
 * ⚠ Не ниже 0.45: под ним лежит фон карточки, и на четвёртом кольце сектор стал бы неотличим от
 * пустого места. Колец у нас максимум три, но правило должно пережить четвёртое.
 */
function ringOpacity(depth: number): number {
  return Math.max(0.45, 1 - depth * 0.28)
}
</script>

<template>
  <div
    class="relative shrink-0"
    :style="{ width: `${size}px`, height: `${size}px`, maxWidth: '100%' }"
  >
    <svg
      viewBox="0 0 100 100"
      :width="size"
      :height="size"
      class="max-w-full"
      role="img"
      :aria-label="ariaLabel"
    >
      <!-- Пустое кольцо вместо «нет данных» текстом: блок сохраняет размер, и таблица под ним не
           прыгает при смене отбора. -->
      <circle
        v-if="!arcs.length"
        cx="50"
        cy="50"
        :r="DEFAULT_SUNBURST.innerRadius + DEFAULT_SUNBURST.ringThickness / 2"
        fill="none"
        :stroke-width="DEFAULT_SUNBURST.ringThickness"
        stroke="var(--chart-track)"
      />
      <path
        v-for="(arc, index) in arcs"
        :key="`${arc.depth}-${arc.key}-${index}`"
        :d="arc.path"
        :fill="colorByRoot[arc.rootKey] ?? 'var(--chart-1)'"
        :fill-opacity="ringOpacity(arc.depth)"
        class="cursor-pointer outline-none transition-opacity hover:opacity-80 focus-visible:opacity-80"
        tabindex="0"
        role="button"
        :aria-label="`${arc.label}: ${arc.value}`"
        @click="emit('pick', arc.key)"
        @keydown.enter.prevent="emit('pick', arc.key)"
        @keydown.space.prevent="emit('pick', arc.key)"
      >
        <title>{{ arc.label }}: {{ arc.value }}</title>
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
