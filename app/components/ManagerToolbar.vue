<script setup lang="ts">
import type { CategoryRef, DealScope, ManagerFilters, CompanyRef, StageRef } from '~/types/managers'
import { COMPANY_UNSET, COMPANY_UNSET_FULL_LABEL, SCOPE_LABELS, stagesForScope } from '~/utils/managerLoad'
import { formatCount, formatDate } from '~/utils/format'

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
  /** Какие «мои компании» встречаются у сделок — по убыванию числа сделок. */
  companies: CompanyRef[]
  /** Сколько сделок у каждой из них под этим отбором — числа на кнопках. */
  companyTotals?: Record<number, number>
  /** Отбор, под которым посчитаны числа на экране. Подпись строится по нему, а не по выбранному. */
  appliedFilters?: ManagerFilters
  isDemo: boolean
  /** «Сегодня» приходит снаружи: интервалы считаются от него, и в тестах он должен быть задан. */
  today: Date
  /** Пока идёт выборка, отбор не меняют: каждая смена — секунд десять запросов к порталу. */
  disabled?: boolean
}>()

const model = defineModel<ManagerFilters>({ required: true })

const categoryItems = computed(() => props.categories.map(category => ({ id: category.id, label: category.name })))

const scopeItems = (Object.keys(SCOPE_LABELS) as DealScope[]).map(scope => ({ id: scope, label: SCOPE_LABELS[scope] }))

/**
 * Кнопки фильтра «Моя компания» — как кнопки периода, и по той же причине: их видно все сразу,
 * вместе с числами, и выбор — одно нажатие вместо «открыть список, найти, нажать».
 *
 * ⚠ Компания показывается ОДНА за раз (решение владельца от 2026-09-05). Пункта «все» нет: круг,
 * поделённый между компаниями, отдавал одной почти всё (на боевом портале 599 сделок против
 * одной), и менеджеры — то, ради чего отчёт открывают, — сжимались в штриховку по краю.
 *
 * ⚠ «Без моей компании» — такая же кнопка, как остальные, а не служебная строка внизу экрана: на
 * боевом портале за всё время это самая крупная группа, и человек сам решает, смотреть её или нет.
 */
const companyButtons = computed(() => props.companies.map(company => ({
  id: company.id,
  label: company.id === COMPANY_UNSET ? COMPANY_UNSET_FULL_LABEL : company.name,
  total: props.companyTotals?.[company.id]
})))

function pickCategory(value: unknown): void {
  const categoryId = Number(value)
  if (!Number.isFinite(categoryId)) return
  model.value = { ...model.value, categoryId }
}

function pickScope(value: unknown): void {
  // ⚠ `Object.hasOwn`, а не `in`: `in` идёт по цепочке прототипов, и значение `toString` из
  // списка (или из подделанной настройки) прошло бы проверку, а экран потом падал бы на
  // `SCOPE_LABELS[scope].toLowerCase()`.
  if (typeof value !== 'string' || !Object.hasOwn(SCOPE_LABELS, value)) return
  model.value = { ...model.value, scope: value as DealScope }
}

/**
 * Выбор «моей компании».
 *
 * ⚠ Ноль — полноценное значение («Без моей компании»), а не «не задано»: сравнение идёт с
 * `undefined`. Повторное нажатие на уже выбранную кнопку в портал не уходит — это полная выборка
 * отчёта, секунды запросов, ради того же самого экрана.
 */
function pickCompany(companyId: number): void {
  if (props.disabled || model.value.companyId === companyId) return
  model.value = { ...model.value, companyId }
}

/** Подпись под панелью: по чему именно посчитаны числа на экране. */
const appliedText = computed(() => {
  const applied = props.appliedFilters
  if (!applied) return undefined
  const category = props.categories.find(item => item.id === applied.categoryId)?.name ?? `направление #${applied.categoryId}`
  const inScope = stagesForScope(props.stages, applied.scope).length
  const company = applied.companyId === undefined
    ? 'компания не выбрана'
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
    </div>

    <!-- Компания — кнопками, как период: их видно все сразу, вместе с числами. -->
    <div
      v-if="companyButtons.length"
      role="group"
      aria-label="Моя компания"
      class="flex flex-wrap items-center gap-2"
      data-export-exclude
      data-testid="company-filter"
    >
      <span class="text-xs opacity-60">Моя компания:</span>
      <button
        v-for="company in companyButtons"
        :key="company.id"
        type="button"
        class="rounded-lg border border-[color:var(--chart-track)] px-2.5 py-1 text-sm transition-colors"
        :class="model.companyId === company.id
          ? 'bg-[color:var(--chart-1)] text-white'
          : 'hover:bg-[color:var(--chart-track)]'"
        :aria-pressed="model.companyId === company.id"
        :disabled="disabled"
        @click="pickCompany(company.id)"
      >
        {{ company.label }}<span
          v-if="company.total !== undefined"
          class="ml-1.5 tabular-nums opacity-70"
        >{{ formatCount(company.total) }}</span>
      </button>
    </div>

    <PeriodPicker
      :period="model.period"
      :today="today"
      :disabled="disabled"
      caption="Созданы:"
      group-label="Период создания сделок"
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
