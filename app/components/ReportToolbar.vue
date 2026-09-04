<script setup lang="ts">
import type { ReportPeriod } from '~/types/report'
import { formatDate } from '~/utils/format'
import { PERIOD_PRESETS, matchPreset, resolvePreset, validatePeriod, type PeriodPresetId } from '~/utils/period'

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

/** Какой готовый интервал сейчас выбран. Ручной ввод «01.09 — 30.09» подсветит «Текущий месяц». */
const activePreset = computed(() => matchPreset(props.period, props.today))

/** Человек нажал «Произвольный» — поле открыто, даже если даты пока совпадают с готовым интервалом. */
const customOpen = ref(false)

/**
 * Произвольный режим активен ОДНИМ условием для подсветки, поля и применения правок.
 *
 * ⚠ Раньше условий было два: поле показывалось при «период не совпал ни с одним интервалом», а
 * правки применялись только при «нажали Произвольный». Пришедший снаружи нестандартный период
 * открывал календарь, в котором можно было выбирать сколько угодно — и ничего не происходило.
 */
const isCustomActive = computed(() => customOpen.value || activePreset.value === 'custom')

const customFrom = ref(props.period.from)
const customTo = ref(props.period.to)

function syncCustomToApplied(): void {
  customFrom.value = props.period.from
  customTo.value = props.period.to
}

watch(() => props.period, syncCustomToApplied)

// Поле закрыли — недобранная половина выбора не должна ждать следующего открытия.
watch(isCustomActive, (active) => {
  if (!active) syncCustomToApplied()
})

/** Активна ли кнопка интервала. Одна функция для цвета и `aria-pressed`, чтобы им негде было разойтись. */
function isPresetActive(id: PeriodPresetId): boolean {
  return id === 'custom' ? isCustomActive.value : id === activePreset.value && !customOpen.value
}

/** Проблема периода, о которой нужно сказать до запроса. */
const problem = ref<string | undefined>(undefined)

function pickPreset(id: PeriodPresetId): void {
  problem.value = undefined
  if (id === 'custom') {
    customOpen.value = true
    return
  }
  customOpen.value = false
  const bounds = resolvePreset(id, props.today)
  if (!bounds) return
  // ⚠ Готовые интервалы проходят ту же проверку, что и ручные: «текущий год» — это до 366 дней
  // выборки, и без проверки он обходил бы предел одним нажатием.
  const issue = validatePeriod(bounds)
  if (issue) {
    problem.value = issue.message
    return
  }
  emit('update:period', bounds)
}

/**
 * Проблема выбранного вручную периода.
 *
 * ⚠ Проверяем ДО запроса. Перевёрнутый период REST принимает без ошибки и возвращает пустой
 * список — отчёт показал бы нули, неотличимые от «за период ничего не было», и человек искал бы
 * ошибку в CRM, а она у него на экране.
 */
const customProblem = computed(() => {
  if (!customFrom.value || !customTo.value) return undefined
  return validatePeriod({ from: customFrom.value, to: customTo.value })
})

// Обе границы выбраны и период годный — применяем. Одна граница — человек ещё выбирает.
watch([customFrom, customTo], () => {
  if (!isCustomActive.value) return
  if (!customFrom.value || !customTo.value || customProblem.value) return
  if (customFrom.value === props.period.from && customTo.value === props.period.to) return
  emit('update:period', { from: customFrom.value, to: customTo.value })
})
</script>

<template>
  <div class="space-y-3">
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
    </div>

    <div
      role="group"
      aria-label="Период отчёта"
      class="flex flex-wrap items-center gap-2"
    >
      <span class="text-xs opacity-60">Период:</span>
      <button
        v-for="preset in PERIOD_PRESETS"
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
