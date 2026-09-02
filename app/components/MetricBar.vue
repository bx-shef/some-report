<script setup lang="ts">
/**
 * Тонкая полоса доли — тот самый индикатор из макета под каждым числом.
 *
 * Своя, а не `B24Progress`: полоса здесь стоит В ЯЧЕЙКЕ ТАБЛИЦЫ десятками штук, ей нужен цвет
 * серии (а не семантический «успех/тревога») и высота в 6 px, иначе строки таблицы разъезжаются.
 */
const props = withDefaults(defineProps<{
  /** Доля 0…1. Значения вне диапазона подрезаются — данные приходят из портала, не из наших рук. */
  value: number
  /** CSS-переменная цвета серии. */
  color?: string
  /** Подпись для скринридера: полоса без неё — просто картинка. */
  label?: string
}>(), {
  color: 'var(--chart-1)',
  label: undefined
})

const percent = computed(() => Math.round(Math.min(1, Math.max(0, props.value || 0)) * 100))
</script>

<template>
  <div
    class="h-1.5 w-full overflow-hidden rounded-full"
    style="background-color: var(--chart-track)"
    role="img"
    :aria-label="label ? `${label}: ${percent} %` : `${percent} %`"
  >
    <div
      class="h-full rounded-full transition-[width] duration-300"
      :style="{ width: `${percent}%`, backgroundColor: color }"
    />
  </div>
</template>
