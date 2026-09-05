<script setup lang="ts">
import { DEFAULT_SUNBURST, sunburstArcs, sunburstLabel, type SunburstNode } from '~/utils/sunburst'

/**
 * Многокольцевая диаграмма на голом SVG: внутреннее кольцо — корни, наружу — их дети.
 *
 * ⚠ Цвет ЗДЕСЬ НИКОГДА не единственный носитель смысла. В секторе написано, что это, у него есть
 * подсказка с числом, рядом легенда, а под диаграммой — полная таблица. Это не оговорка про
 * доступность, а условие, при котором палитра `--chart-*` признана годной: различимость соседей
 * она проходит, а контраст к фону — не везде (`app/assets/css/main.css`).
 *
 * ⚠ Кольца одной ветки — один тон разной насыщенности: иначе непонятно, чьи это дети. Насыщенность
 * падает наружу, поэтому внешние кольца светлее.
 */
const props = withDefaults(defineProps<{
  nodes: SunburstNode[]
  /** Цвета корней по ключу — палитру задаёт вызывающая сторона, у диаграммы своей нет. */
  colorByRoot: Record<string, string>
  /**
   * Цвет подписи на секторе этого корня: белый на тёмном, тёмный на светлом (`--chart-N-ink`).
   *
   * ⚠ Действует только на ВНУТРЕННЕМ кольце. Внешние рисуются полупрозрачными и подмешивают фон
   * карточки, отчего `--chart-N-ink` падает до 2,7:1; там подпись пишется одним на тему
   * `--chart-ink-veiled` — смешение всегда идёт в сторону фона, поэтому он и работает.
   */
  inkByRoot: Record<string, string>
  /**
   * Ключи секторов, за которыми есть список.
   *
   * ⚠ Обязательный список, а не «кликабельно всё». У свёрнутого хвоста менеджеров («Остальные») и
   * у сделок без ответственного списка нет — такое условие фильтром REST не выразить. Такой сектор
   * не должен быть ни кнопкой, ни точкой табуляции: со скринридера и с клавиатуры он выглядел бы
   * сломанной кнопкой, а правило отчёта — число без совпадающего списка НЕ кликабельно.
   */
  pickable: readonly string[]
  /** Крупное число в центре. */
  centerValue?: string
  centerLabel?: string
  size?: number
  /** Что именно разбито на секторы — читает скринридер. */
  ariaLabel?: string
}>(), {
  centerValue: undefined,
  centerLabel: undefined,
  size: 420,
  ariaLabel: 'Кольцевая диаграмма распределения'
})

const emit = defineEmits<{ pick: [string] }>()

/** Высота подписи в единицах viewBox: 100 единиц — это `size` пикселей на экране. */
const FONT = 2.9

/**
 * Дуги вместе с готовыми подписями.
 *
 * Подпись считается ОДИН раз на сектор, а не в `v-if` и ещё раз в интерполяции: секторов до
 * четырёх десятков, и перерисовка гоняла бы `sunburstLabel` вдвое чаще без всякой нужды.
 */
const arcs = computed(() => sunburstArcs(props.nodes, DEFAULT_SUNBURST).map(arc => ({
  ...arc,
  text: sunburstLabel(arc, FONT)
})))

const pickableKeys = computed(() => new Set(props.pickable))

function pick(key: string): void {
  if (pickableKeys.value.has(key)) emit('pick', key)
}

/**
 * Прозрачность кольца: 1 — внутреннее, дальше светлее.
 *
 * ⚠ Не ниже 0.55: под ним лежит фон карточки, и на третьем кольце сектор стал бы неотличим от
 * пустого места, а подпись на нём — нечитаемой.
 */
function ringOpacity(depth: number): number {
  return Math.max(0.55, 1 - depth * 0.3)
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
      <g
        v-for="(arc, index) in arcs"
        :key="`${arc.depth}-${arc.key}-${index}`"
      >
        <path
          :d="arc.path"
          :fill="colorByRoot[arc.rootKey] ?? 'var(--chart-1)'"
          :fill-opacity="ringOpacity(arc.depth)"
          class="outline-none transition-opacity"
          :class="pickableKeys.has(arc.key) ? 'cursor-pointer hover:opacity-80 focus-visible:opacity-80' : ''"
          :tabindex="pickableKeys.has(arc.key) ? 0 : undefined"
          :role="pickableKeys.has(arc.key) ? 'button' : undefined"
          :aria-label="pickableKeys.has(arc.key) ? `${arc.label}: ${arc.value}` : undefined"
          @click="pick(arc.key)"
          @keydown.enter.prevent="pick(arc.key)"
          @keydown.space.prevent="pick(arc.key)"
        >
          <title>{{ arc.label }}: {{ arc.value }}</title>
        </path>
        <!-- ⚠ Подпись не перехватывает мышь (`pointer-events-none`): иначе клик по имени менеджера
             не открывал бы список, хотя визуально человек нажал ровно на сектор.

             ⚠ И не читается скринридером (`aria-hidden`): то же самое уже сказано в `aria-label`
             сектора и в `<title>`, вместе с числом. Без этого имя менеджера произносилось бы
             дважды подряд — один раз как название кнопки, второй как текст рядом с ней. -->
        <text
          v-if="arc.text"
          :x="arc.labelAt.x"
          :y="arc.labelAt.y"
          :transform="`rotate(${arc.labelAt.rotate} ${arc.labelAt.x} ${arc.labelAt.y})`"
          :font-size="FONT"
          :fill="arc.depth === 0 ? (inkByRoot[arc.rootKey] ?? 'var(--chart-1-ink)') : 'var(--chart-ink-veiled)'"
          text-anchor="middle"
          dominant-baseline="central"
          aria-hidden="true"
          class="pointer-events-none select-none"
        >{{ arc.text }}</text>
      </g>
    </svg>
    <div
      v-if="centerValue"
      class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
    >
      <span class="text-xl font-semibold leading-none">{{ centerValue }}</span>
      <span
        v-if="centerLabel"
        class="mt-1 text-xs opacity-60"
      >{{ centerLabel }}</span>
    </div>
  </div>
</template>
