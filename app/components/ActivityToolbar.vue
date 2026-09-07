<script setup lang="ts">
import type { ActivityFilters, DepartmentRef } from '~/types/activity'
import { CALL_THRESHOLD_CHOICES, DEFAULT_CALL_THRESHOLD_SECONDS, thresholdLabel } from '~/types/activity'
import { sortDepartments } from '~/utils/activityAdapter'
import { ACTIVITY_MAX_DAYS } from '~/composables/useActivityReport'
import { formatDate } from '~/utils/format'
import { reportTitle } from '~/utils/pageTitle'

/**
 * Панель отчёта «Активность пользователей»: отдел, период и порог разговора.
 *
 * ⚠ Отдел — необязательный: умолчание «Все отделы». Прежний отчёт заказчика считал ОДИН отдел,
 * зашитый в коде (`DEPARTMENT = 62`), и вопрос «а как у соседей» задать было нечем.
 *
 * ⚠ Порог — НАСТРОЙКА, а не константа (решение владельца 2026-09-06), и стоит он прямо в панели,
 * а не в отдельном окне настроек: он меняет ВСЕ числа отчёта, и человек, читающий таблицу, обязан
 * видеть, каким порогом она посчитана, не уходя с экрана.
 */
const props = defineProps<{
  /** Отделы портала — дерево. Пустой список означает, что справочник не прочитался. */
  departments: DepartmentRef[]
  /** Отбор, под которым посчитаны числа на экране. Подпись строится по нему, а не по выбранному. */
  appliedFilters?: ActivityFilters
  isDemo: boolean
  /** «Сегодня» приходит снаружи: интервалы считаются от него, и в тестах он должен быть задан. */
  today: Date
  /** Пока идёт выборка, отбор не меняют: каждая смена — секунды запросов к порталу. */
  disabled?: boolean
}>()

const model = defineModel<ActivityFilters>({ required: true })

/** Пункт «все отделы» — отдельным значением, потому что `undefined` выпадающий список не хранит. */
const ALL_DEPARTMENTS = 0

/**
 * Пункты фильтра отделов — по алфавиту, а не деревом с отступами.
 *
 * ⚠ Дерево в выпадающем списке из 43 пунктов читается хуже плоского алфавита: отступы съедают
 * ширину, а искать человек всё равно будет по названию. Иерархия при этом НЕ теряется — она в
 * самом отборе: выбранный отдел берётся вместе с подотделами (`departmentSubtree`).
 */
const departmentItems = computed(() => {
  const items = [
    { id: ALL_DEPARTMENTS, label: 'Все отделы' },
    ...sortDepartments(props.departments).map(department => ({ id: department.id, label: department.name }))
  ]
  /**
   * ⚠ Выбранный отдел, которого в справочнике НЕТ, всё равно должен быть в списке. Такое бывает
   * с запомненным отбором: отдел удалили, а настройка человека его помнит. Без этой строки
   * `B24SelectMenu` печатает в поле голое число («999»), пока подпись под панелью и объяснение
   * пустоты говорят «отдел #999» — три места экрана называют одно и то же тремя способами.
   */
  const picked = model.value.departmentId
  return picked !== undefined && !items.some(item => item.id === picked)
    ? [...items, { id: picked, label: `отдел #${picked}` }]
    : items
})

function pickDepartment(value: unknown): void {
  const id = Number(value)
  model.value = {
    ...model.value,
    // ⚠ Ноль здесь — это «все», то есть ОТСУТСТВИЕ условия, а не отдел с номером 0. Оставь мы
    // ноль в отборе, ядро искало бы сотрудников отдела «0» и таблица оказалась бы пустой.
    ...(Number.isFinite(id) && id > 0 ? { departmentId: id } : { departmentId: undefined })
  }
}

/**
 * Пороги на выбор.
 *
 * ⚠ Список, а не поле ввода: порог меняет все числа отчёта, и «29» здесь не круглое число, а
 * ПРАВИЛО ЗАКАЗЧИКА из прежнего отчёта. Свободный ввод приглашал бы поставить 30 «для красоты» и
 * молча разойтись со всеми прежними отчётами; готовые значения делают выбор осознанным.
 */
const thresholdItems = CALL_THRESHOLD_CHOICES.map(seconds => ({ id: seconds, label: thresholdLabel(seconds) }))

function pickThreshold(value: unknown): void {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return
  model.value = { ...model.value, thresholdSeconds: seconds }
}

/** Подпись под панелью: по чему именно посчитаны числа на экране. */
const appliedText = computed(() => {
  const applied = props.appliedFilters
  if (!applied) return undefined
  const department = applied.departmentId === undefined
    ? 'все отделы'
    : (props.departments.find(item => item.id === applied.departmentId)?.name ?? `отдел #${applied.departmentId}`)
  /**
   * ⚠ Отличие от порога ЗАКАЗЧИКА называется прямо. Раньше порог сбрасывался при каждом
   * открытии, и это была естественная точка схождения: двое, открывшие отчёт независимо, видели
   * одни числа. Теперь порог запоминается — и человек может неделями смотреть на цифры,
   * посчитанные не по стандарту, а потом не понять, почему они расходятся с цифрами коллеги.
   */
  const threshold = applied.thresholdSeconds === DEFAULT_CALL_THRESHOLD_SECONDS
    ? `разговоры дольше ${applied.thresholdSeconds} с`
    : applied.thresholdSeconds > 0
      ? `разговоры дольше ${applied.thresholdSeconds} с (не ${DEFAULT_CALL_THRESHOLD_SECONDS} с, как обычно)`
      : `все состоявшиеся разговоры (без порога в ${DEFAULT_CALL_THRESHOLD_SECONDS} с, как обычно)`
  // ⚠ «Дела и звонки за» здесь обязательно: период считается по дате СОЗДАНИЯ записи, и без этого
  // слова числа читались бы как «сколько сейчас в работе», а это другой вопрос. Просрочка —
  // единственное исключение, и о нём говорит подпись столбца.
  return `${department}, ${threshold}, дела и звонки за ${formatDate(applied.period.from)} — ${formatDate(applied.period.to)}`
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="mr-auto text-xl font-bold">
        {{ reportTitle('/app/activity') }}
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
        :model-value="model.departmentId ?? ALL_DEPARTMENTS"
        :items="departmentItems"
        value-key="id"
        label-key="label"
        placeholder="Отдел"
        aria-label="Отдел"
        size="sm"
        :disabled="disabled || departments.length === 0"
        class="w-64"
        data-testid="department-filter"
        @update:model-value="pickDepartment"
      />
      <B24SelectMenu
        :model-value="model.thresholdSeconds"
        :items="thresholdItems"
        value-key="id"
        label-key="label"
        placeholder="Порог разговора"
        aria-label="Какие разговоры считать"
        size="sm"
        :search-input="false"
        :disabled="disabled"
        class="w-56"
        data-testid="threshold-filter"
        @update:model-value="pickThreshold"
      />
    </div>

    <PeriodPicker
      :period="model.period"
      :today="today"
      :disabled="disabled"
      :max-days="ACTIVITY_MAX_DAYS"
      caption="Дела и звонки за:"
      group-label="Период дел и звонков"
      @update:period="bounds => model = { ...model, period: bounds }"
    />

    <p
      v-if="appliedText"
      class="text-xs opacity-60"
    >
      {{ appliedText }}
    </p>
  </div>
</template>
