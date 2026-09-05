<script setup lang="ts">
import type { ReportPeriod } from '~/types/report'

/**
 * Выбор периода целиком: кнопки готовых интервалов, календарь произвольных дат и обе жалобы.
 *
 * ⚠ Компонент, а не только композабл, и это не лишний слой. Разметка периода в обеих панелях была
 * побайтно одинаковой — сорок с лишним строк, отличавшихся подписью и `aria-label`. Логику мы
 * свели в `usePeriodPicker`, а вёрстка осталась бы двумя копиями и разъехалась бы ровно так же:
 * по классам кнопок, по тексту жалобы, по тому, попадает ли блок в PDF-снимок.
 *
 * Панели остаются разными: у отчёта по лидам период — самостоятельная модель, у отчёта по
 * менеджерам — часть отбора. Поэтому наружу отдаётся событие, а как его применить, решает панель.
 */
const props = defineProps<{
  /** Выбранный период — источник истины у панели. */
  period: ReportPeriod
  /** «Сегодня»: интервалы считаются от него, и в тестах он должен быть задан. */
  today: Date
  /**
   * Подпись перед кнопками. У отчётов она разная не для красоты: во втором период считается по
   * дате СОЗДАНИЯ сделки, и «Созданы:» — единственное, что об этом говорит рядом с кнопками.
   */
  caption?: string
  /** Что именно выбирают — читает скринридер. */
  groupLabel?: string
  /** Пока идёт выборка, период не меняют: каждая смена — секунды запросов к порталу. */
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:period': [ReportPeriod] }>()

const {
  presets, isPresetActive, isCustomActive, customFrom, customTo, problem, customProblem, pickPreset
} = usePeriodPicker({
  period: () => props.period,
  today: () => props.today,
  disabled: () => Boolean(props.disabled),
  apply: bounds => emit('update:period', bounds)
})
</script>

<template>
  <div class="space-y-3">
    <!-- В PDF-снимок кнопки периода не попадают (`data-export-exclude`): период там — подписью. -->
    <div
      role="group"
      :aria-label="groupLabel ?? 'Период отчёта'"
      class="flex flex-wrap items-center gap-2"
      data-export-exclude
    >
      <span class="text-xs opacity-60">{{ caption ?? 'Период:' }}</span>
      <button
        v-for="preset in presets"
        :key="preset.id"
        type="button"
        class="rounded-lg border border-[color:var(--chart-track)] px-2.5 py-1 text-sm transition-colors"
        :class="isPresetActive(preset.id)
          ? 'bg-[color:var(--chart-1)] text-[color:var(--chart-1-ink)]'
          : 'hover:bg-[color:var(--chart-track)]'"
        :aria-pressed="isPresetActive(preset.id)"
        :disabled="disabled"
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

    <!-- ⚠ Во время выборки календарь гасим ВИДОМ, а запрет живёт в композабле: у поля дат b24ui
         своего `disabled` нет, и без запрета в логике человек менял бы период посреди выборки. -->
    <div
      v-if="isCustomActive"
      class="space-y-2"
      :class="disabled ? 'pointer-events-none opacity-60' : ''"
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
