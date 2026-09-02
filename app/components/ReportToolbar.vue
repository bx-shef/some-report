<script setup lang="ts">
import type { ConversionBase } from '~/types/report'

/**
 * Панель отчёта. Главный её элемент — переключатель ЗНАМЕНАТЕЛЯ конверсий.
 *
 * ⚠ Это не настройка «на всякий случай». ТЗ и согласованный макет считают конверсии по-разному
 * (см. `docs/METRICS.md`), и на одних и тех же данных отчёт даёт 100 % или 80 %. Пока решение не
 * принято, прятать его в код — значит выбрать молча за клиента; переключатель делает разницу
 * видимой ровно там, где на неё смотрят.
 */
const props = defineProps<{
  conversionBase: ConversionBase
  period: { from: string, to: string }
  isDemo: boolean
}>()

const emit = defineEmits<{ 'update:conversionBase': [ConversionBase] }>()

const BASES: Array<{ value: ConversionBase, label: string, hint: string }> = [
  { value: 'quality-leads', label: 'Качественные лиды', hint: 'Лиды − Брак. Так написано в ТЗ' },
  { value: 'all-leads', label: 'Все лиды', hint: 'Весь поток. Так посчитаны цифры на макете' }
]

const periodText = computed(() => {
  const format = (iso: string) => {
    const [y, m, d] = iso.split('-')
    return `${d}.${m}.${y}`
  }
  return `${format(props.period.from)} — ${format(props.period.to)}`
})
</script>

<template>
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
</template>
