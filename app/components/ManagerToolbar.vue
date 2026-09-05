<script setup lang="ts">
import type { CategoryRef, DealScope, ManagerFilters, CompanyRef, StageRef } from '~/types/managers'
import { COMPANY_UNSET, COMPANY_UNSET_FULL_LABEL, SCOPE_LABELS, stagesForScope } from '~/utils/managerLoad'
import { formatDate } from '~/utils/format'
import { PERIOD_PRESETS, matchPreset, resolvePreset, validatePeriod, type PeriodPresetId } from '~/utils/period'

/**
 * Панель отчёта «Сделки по менеджерам»: направление, охват, «моя компания» и период создания.
 *
 * ⚠ Направление — ОДНО и обязательно. Стадии у направлений свои: у заказчика их четыре, и
 * «Новая» в каждом со своим кодом. Колонки таблицы имеют смысл только внутри одного направления,
 * а «все направления» дали бы шестьдесят с лишним столбцов, половина которых называется
 * одинаково и значит разное.
 *
 * ⚠ Период здесь тот же, что в отчёте по лидам, — кнопки готовых интервалов и календарь, — и
 * «за всё время» среди них НЕТ. Решение владельца от 2026-09-05: на боевом портале в направлении
 * 616 тысяч сделок, и отбор без периода отвечал на вопрос «что было за все годы» минутами
 * ожидания. Умолчание — текущий месяц.
 */
const props = defineProps<{
  categories: CategoryRef[]
  /** Все стадии выбранного направления — чтобы подписать, сколько их в охвате. */
  stages: StageRef[]
  /** Какие «мои компании» встречаются у сделок — список для фильтра. */
  companies: CompanyRef[]
  /** Отбор, под которым посчитаны числа на экране. Подпись строится по нему, а не по выбранному. */
  appliedFilters?: ManagerFilters
  isDemo: boolean
  /** «Сегодня» приходит снаружи: интервалы считаются от него, и в тестах он должен быть задан. */
  today: Date
  /** Пока идёт выборка, отбор не меняют: каждая смена — секунд десять запросов к порталу. */
  disabled?: boolean
}>()

const model = defineModel<ManagerFilters>({ required: true })

/** «Все компании» — отсутствие фильтра. Ноль занят: это «Без моей компании». */
const ALL_COMPANIES = -1

const categoryItems = computed(() => props.categories.map(category => ({ id: category.id, label: category.name })))

const scopeItems = (Object.keys(SCOPE_LABELS) as DealScope[]).map(scope => ({ id: scope, label: SCOPE_LABELS[scope] }))

/**
 * Пункты фильтра «Моя компания»: все, каждая компания и «Без моей компании».
 *
 * ⚠ «Без моей компании» — такой же пункт, как остальные, а не служебная строка внизу экрана.
 * Решение владельца от 2026-09-05: на боевом портале поле заполнено у 8 % сделок, и человек сам
 * решает, смотреть их отдельно или вместе со всеми.
 */
const companyItems = computed(() => [
  { id: ALL_COMPANIES, label: 'Все компании' },
  ...props.companies.map(company => ({
    id: company.id,
    label: company.id === COMPANY_UNSET ? COMPANY_UNSET_FULL_LABEL : company.name
  }))
])

const companyValue = computed(() => model.value.companyId ?? ALL_COMPANIES)

function pickCategory(value: unknown): void {
  const categoryId = Number(value)
  if (!Number.isFinite(categoryId)) return
  model.value = { ...model.value, categoryId }
}

function pickScope(value: unknown): void {
  if (typeof value !== 'string' || !(value in SCOPE_LABELS)) return
  model.value = { ...model.value, scope: value as DealScope }
}

/**
 * Выбор «моей компании».
 *
 * ⚠ Ноль — полноценное значение («Без моей компании»), поэтому «все» помечены `-1`, а ключ
 * `companyId` при выборе «всех» УДАЛЯЕТСЯ из отбора: `companyId: undefined` в объекте отличается
 * от отсутствия ключа при сравнении отборов и при сохранении их в настройки пользователя.
 */
function pickCompany(value: unknown): void {
  const companyId = Number(value)
  if (!Number.isFinite(companyId)) return
  if (companyId === ALL_COMPANIES) {
    const { companyId: _all, ...rest } = model.value
    model.value = rest
    return
  }
  model.value = { ...model.value, companyId }
}

/** Какой готовый интервал сейчас выбран. Ручной ввод «01.09 — 30.09» подсветит «Текущий месяц». */
const activePreset = computed(() => matchPreset(model.value.period, props.today))

/** Человек нажал «Произвольный» — поле открыто, даже если даты пока совпадают с готовым интервалом. */
const customOpen = ref(false)

const isCustomActive = computed(() => customOpen.value || activePreset.value === 'custom')

const customFrom = ref(model.value.period.from)
const customTo = ref(model.value.period.to)

function syncCustomToApplied(): void {
  customFrom.value = model.value.period.from
  customTo.value = model.value.period.to
}

watch(() => model.value.period, syncCustomToApplied)

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
  const issue = validatePeriod(bounds)
  if (issue) {
    problem.value = issue.message
    return
  }
  model.value = { ...model.value, period: bounds }
}

/**
 * Проблема выбранного вручную периода.
 *
 * ⚠ Проверяем ДО запроса. Перевёрнутый период REST принимает без ошибки и возвращает пустой
 * список — отчёт показал бы нули, неотличимые от «за период сделок не заводили».
 */
const customProblem = computed(() => {
  if (!customFrom.value || !customTo.value) return undefined
  return validatePeriod({ from: customFrom.value, to: customTo.value })
})

// Обе границы выбраны и период годный — применяем. Одна граница — человек ещё выбирает.
watch([customFrom, customTo], () => {
  if (!isCustomActive.value) return
  if (!customFrom.value || !customTo.value || customProblem.value) return
  if (customFrom.value === model.value.period.from && customTo.value === model.value.period.to) return
  model.value = { ...model.value, period: { from: customFrom.value, to: customTo.value } }
})

/** Подпись под панелью: по чему именно посчитаны числа на экране. */
const appliedText = computed(() => {
  const applied = props.appliedFilters
  if (!applied) return undefined
  const category = props.categories.find(item => item.id === applied.categoryId)?.name ?? `направление #${applied.categoryId}`
  const inScope = stagesForScope(props.stages, applied.scope).length
  const company = applied.companyId === undefined
    ? 'все компании'
    : applied.companyId === COMPANY_UNSET
      ? COMPANY_UNSET_FULL_LABEL.toLowerCase()
      : (props.companies.find(item => item.id === applied.companyId)?.name ?? `компания #${applied.companyId}`)
  // ⚠ «Созданы» здесь обязательно: период считается по дате СОЗДАНИЯ сделки, и сделка в работе с
  // прошлого квартала в «текущий месяц» не попадает. Без этого слова числа читались бы как
  // «сколько сейчас в работе», а это другой вопрос.
  return `${category}: ${SCOPE_LABELS[applied.scope].toLowerCase()} (стадий в охвате: ${inScope} из ${props.stages.length}), ${company}, созданы ${formatDate(applied.period.from)} — ${formatDate(applied.period.to)}`
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
        :model-value="companyValue"
        :items="companyItems"
        value-key="id"
        label-key="label"
        placeholder="Моя компания"
        aria-label="Моя компания"
        size="sm"
        :search-input="false"
        :disabled="disabled || companyItems.length < 2"
        class="w-56"
        data-testid="company-filter"
        @update:model-value="pickCompany"
      />
    </div>

    <!-- В PDF-снимок кнопки периода не попадают (`data-export-exclude`): период там — подписью. -->
    <div
      role="group"
      aria-label="Период создания сделок"
      class="flex flex-wrap items-center gap-2"
      data-export-exclude
    >
      <span class="text-xs opacity-60">Созданы:</span>
      <button
        v-for="preset in PERIOD_PRESETS"
        :key="preset.id"
        type="button"
        class="rounded-lg border border-[color:var(--chart-track)] px-2.5 py-1 text-sm transition-colors"
        :class="isPresetActive(preset.id)
          ? 'bg-[color:var(--chart-1)] text-white'
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

    <div
      v-if="isCustomActive"
      class="space-y-2"
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

    <p
      v-if="appliedText"
      class="text-xs opacity-60"
    >
      {{ appliedText }}
    </p>
  </div>
</template>
