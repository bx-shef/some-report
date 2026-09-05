<script setup lang="ts">
import type { CategoryRef, DealScope, ManagerFilters, StageRef } from '~/types/managers'
import { SCOPE_LABELS, stagesForScope } from '~/utils/managerLoad'
import { formatDate } from '~/utils/format'
import { PERIOD_PRESETS, resolvePreset, type PeriodPresetId } from '~/utils/period'

/**
 * Панель отчёта «Сделки по менеджерам»: направление, охват и период создания.
 *
 * ⚠ Направление — ОДНО и обязательно. Стадии у направлений свои: у заказчика их четыре, и
 * «Новая» в каждом со своим кодом. Колонки таблицы имеют смысл только внутри одного направления,
 * а «все направления» дали бы шестьдесят с лишним столбцов, половина которых называется
 * одинаково и значит разное.
 *
 * ⚠ Период по умолчанию — «за всё время», и это не лень. Вопрос «сколько сделок на менеджере»
 * про ТЕКУЩУЮ загрузку: сделка в работе с прошлого квартала — это работа сегодня, и период по
 * дате создания выкинул бы её из таблицы.
 */
const props = defineProps<{
  categories: CategoryRef[]
  /** Все стадии выбранного направления — чтобы подписать, сколько их в охвате. */
  stages: StageRef[]
  /** Отбор, под которым посчитаны числа на экране. Подпись строится по нему, а не по выбранному. */
  appliedFilters?: ManagerFilters
  isDemo: boolean
  /** «Сегодня» приходит снаружи: интервалы считаются от него, и в тестах он должен быть задан. */
  today: Date
  /** Пока идёт выборка, отбор не меняют: каждая смена — секунд десять запросов к порталу. */
  disabled?: boolean
}>()

const model = defineModel<ManagerFilters>({ default: () => ({ categoryId: 0, scope: 'in-work' }) })

/** Пункт «за всё время» в том же списке, что и готовые интервалы: это тоже выбор периода. */
const ALL_TIME = 'all-time'

const categoryItems = computed(() => props.categories.map(category => ({ id: category.id, label: category.name })))

const scopeItems = (Object.keys(SCOPE_LABELS) as DealScope[]).map(scope => ({ id: scope, label: SCOPE_LABELS[scope] }))

/**
 * Интервалы: «за всё время» и готовые периоды. Произвольных дат здесь нет намеренно — отчёт
 * отвечает на вопрос «что сейчас», и календарь на две даты в нём только отвлекает.
 */
const periodItems = computed(() => [
  { id: ALL_TIME, label: 'За всё время' },
  ...PERIOD_PRESETS.filter(preset => preset.resolve).map(preset => ({ id: preset.id, label: preset.label }))
])

/** Какой пункт периода выбран сейчас: сравниваем по границам, а не по имени. */
const periodValue = computed(() => {
  const period = model.value.period
  if (!period) return ALL_TIME
  for (const preset of PERIOD_PRESETS) {
    const bounds = preset.resolve?.(props.today)
    if (bounds && bounds.from === period.from && bounds.to === period.to) return preset.id
  }
  return ALL_TIME
})

function pickCategory(value: unknown): void {
  const categoryId = Number(value)
  if (!Number.isFinite(categoryId)) return
  model.value = { ...model.value, categoryId }
}

function pickScope(value: unknown): void {
  if (typeof value !== 'string' || !(value in SCOPE_LABELS)) return
  model.value = { ...model.value, scope: value as DealScope }
}

function pickPeriod(value: unknown): void {
  if (value === ALL_TIME || value === null || value === undefined) {
    const { period: _drop, ...rest } = model.value
    model.value = rest
    return
  }
  const bounds = resolvePreset(value as PeriodPresetId, props.today)
  if (bounds) model.value = { ...model.value, period: bounds }
}

/** Подпись под панелью: по чему именно посчитаны числа на экране. */
const appliedText = computed(() => {
  const applied = props.appliedFilters
  if (!applied) return undefined
  const category = props.categories.find(item => item.id === applied.categoryId)?.name ?? `направление #${applied.categoryId}`
  const inScope = stagesForScope(props.stages, applied.scope).length
  const period = applied.period
    ? `созданы ${formatDate(applied.period.from)} — ${formatDate(applied.period.to)}`
    : 'за всё время'
  return `${category}: ${SCOPE_LABELS[applied.scope].toLowerCase()} (стадий в охвате: ${inScope} из ${props.stages.length}), ${period}`
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="mr-auto text-xl font-bold">
        Сделки по менеджерам
      </h1>

      <slot name="actions" />

      <B24Badge
        v-if="isDemo"
        color="air-primary-warning"
        label="Демо-данные"
      />
    </div>

    <div
      role="group"
      aria-label="Отбор отчёта"
      class="flex flex-wrap items-center gap-2"
      data-export-exclude
    >
      <span class="text-xs opacity-60">Отбор:</span>
      <B24SelectMenu
        :model-value="model.categoryId"
        :items="categoryItems"
        value-key="id"
        label-key="label"
        placeholder="Направление"
        aria-label="Направление"
        size="sm"
        :search-input="false"
        :disabled="disabled || !categoryItems.length"
        class="w-56"
        @update:model-value="pickCategory"
      />
      <B24SelectMenu
        :model-value="model.scope"
        :items="scopeItems"
        value-key="id"
        label-key="label"
        placeholder="Стадии"
        aria-label="Какие сделки считать"
        size="sm"
        :search-input="false"
        :disabled="disabled"
        class="w-40"
        @update:model-value="pickScope"
      />
      <B24SelectMenu
        :model-value="periodValue"
        :items="periodItems"
        value-key="id"
        label-key="label"
        placeholder="Период создания"
        aria-label="Период создания сделки"
        size="sm"
        :search-input="false"
        :disabled="disabled"
        class="w-48"
        @update:model-value="pickPeriod"
      />
    </div>

    <p
      v-if="appliedText"
      class="text-xs opacity-60"
    >
      {{ appliedText }}
    </p>
  </div>
</template>
