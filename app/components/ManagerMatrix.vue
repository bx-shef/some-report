<script setup lang="ts">
import type { ManagerCellRef, ManagerLoadCompany, ManagerLoadReport } from '~/types/managers'
import { UNLISTED_MANAGER_LABEL } from '~/utils/managerLoad'
import { formatCount, formatPercent } from '~/utils/format'

/**
 * Матрица «компания → менеджер → стадия»: по карточке на компанию, строка на менеджера, столбец на
 * стадию. Компонент только рисует: ни одной формулы здесь нет — всё посчитано ядром
 * (`app/utils/managerLoad.ts`), а условие списка за числом собирает страница.
 *
 * ⚠ Пустых столбцов нет: у направления заказчика 16 стадий, а «в работе» из них четыре.
 * Сколько скрыто — сказано подписью, чтобы сверка со справочником CRM не выглядела как потеря.
 *
 * ⚠ Таблица прокручивается ВНУТРИ карточки (`overflow-x-auto`), а не растягивает страницу: во
 * фрейме портала горизонтальный скролл всей страницы прячет часть отчёта под край окна.
 *
 * ⚠ Числа здесь — свои кнопки, а не `DrillNumber`: тому нужен ГОТОВЫЙ запрос списка, а его
 * собирает страница (она знает отбор), поэтому компонент отдаёт наружу только «по какой клетке
 * нажали». Общий у них вид — класс `.drill-number`, чтобы кликабельные числа в обоих отчётах не
 * разъехались: часть подчёркнута, часть нет, и человек перестаёт понимать, где список есть.
 */
const props = defineProps<{
  report: ManagerLoadReport
}>()

const emit = defineEmits<{ drill: [ManagerCellRef] }>()

/**
 * Кому досталось больше всех в компании — по нему меряются полосы строк.
 *
 * Считается один раз на компанию, а не в каждой ячейке: строк в таблице десятки, и вызов из шаблона
 * повторялся бы на каждую перерисовку — так же, как это уже сделано в блоке источников.
 */
const peaks = computed(() => {
  const out: Record<number, number> = {}
  for (const company of props.report.companies) {
    out[company.companyId] = company.rows.reduce((max, row) => Math.max(max, row.total), 0)
  }
  return out
})

/** Клик по числу: заголовок списка повторяет то, по чему нажали. */
function cell(company: ManagerLoadCompany, parts: { managerId?: number, managerName?: string, stageId?: string, stageName?: string, total: number }): ManagerCellRef {
  const title = [company.companyName, parts.managerName, parts.stageName].filter(Boolean).join(' · ')
  return {
    companyId: company.companyId,
    ...(parts.managerId === undefined ? {} : { managerId: parts.managerId }),
    ...(parts.stageId === undefined ? {} : { stageId: parts.stageId }),
    title: `Сделки: ${title}`,
    total: parts.total
  }
}

const hasOther = computed(() => props.report.otherStages > 0)
</script>

<template>
  <div class="space-y-4">
    <B24Card
      v-for="company in report.companies"
      :key="company.companyId"
    >
      <template #header>
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-base font-semibold">
            {{ company.companyName }}
          </h2>
          <p class="text-sm opacity-70">
            сделок: <span class="font-semibold">{{ formatCount(company.total) }}</span>
            ({{ formatPercent(company.share) }} от всех)
          </p>
        </div>
      </template>

      <div class="overflow-x-auto">
        <table class="w-full min-w-[640px] text-sm">
          <thead>
            <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
              <th class="py-2 pr-3 font-normal">
                Менеджер
              </th>
              <th
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right font-normal"
              >
                {{ stage.name }}
              </th>
              <th
                v-if="hasOther"
                class="py-2 pr-3 text-right font-normal"
              >
                Прочие стадии
              </th>
              <th class="py-2 text-right font-normal">
                Всего
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in company.rows"
              :key="row.managerId"
              class="border-b border-[color:var(--chart-track)]"
            >
              <td class="py-2 pr-3">
                <div class="min-w-[12rem]">
                  {{ row.managerName }}
                  <MetricBar
                    class="mt-1"
                    :value="peaks[company.companyId] ? row.total / peaks[company.companyId]! : 0"
                    :label="`${row.managerName}: ${formatCount(row.total)}`"
                  />
                </div>
              </td>
              <td
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right tabular-nums"
              >
                <button
                  v-if="row.byStage[stage.id]"
                  type="button"
                  class="drill-number"
                  :title="`Открыть список: ${row.managerName}, ${stage.name}`"
                  @click="emit('drill', cell(company, { managerId: row.managerId, managerName: row.managerName, stageId: stage.id, stageName: stage.name, total: row.byStage[stage.id]! }))"
                >
                  {{ formatCount(row.byStage[stage.id]!) }}
                </button>
                <span
                  v-else
                  class="opacity-30"
                >—</span>
              </td>
              <!-- Стадии вне справочника: число есть, а списка «тем же условием» нет — стадий мы
                   не знаем. Поэтому оно и не притворяется ссылкой. -->
              <td
                v-if="hasOther"
                class="py-2 pr-3 text-right tabular-nums opacity-70"
              >
                {{ row.otherStages ? formatCount(row.otherStages) : '—' }}
              </td>
              <td class="py-2 text-right font-semibold tabular-nums">
                <button
                  type="button"
                  class="drill-number"
                  :title="`Открыть список: все сделки, ${row.managerName}`"
                  @click="emit('drill', cell(company, { managerId: row.managerId, managerName: row.managerName, total: row.total }))"
                >
                  {{ formatCount(row.total) }}
                </button>
              </td>
            </tr>

            <!-- Сделки компании без строки: ответственный не назначен или не попал в перечисление. -->
            <tr
              v-if="company.unlisted > 0"
              class="border-b border-[color:var(--chart-track)]"
            >
              <td class="py-2 pr-3 opacity-70">
                {{ UNLISTED_MANAGER_LABEL }}
              </td>
              <!-- Стадия у этих сделок известна (итог колонки — счётчик портала), а
                   ответственный нет: числа есть, но списка «тем же условием» за ними не собрать —
                   «ответственный не из списка» фильтром REST не выражается. Поэтому не кнопки. -->
              <td
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right tabular-nums opacity-70"
              >
                {{ company.unlistedByStage[stage.id] ? formatCount(company.unlistedByStage[stage.id]!) : '—' }}
              </td>
              <td
                v-if="hasOther"
                class="py-2 pr-3 text-right opacity-30"
              >
                —
              </td>
              <td class="py-2 text-right tabular-nums opacity-70">
                {{ formatCount(company.unlisted) }}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="text-sm font-semibold">
              <td class="py-2 pr-3">
                Итого по компании
              </td>
              <td
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right tabular-nums"
              >
                <button
                  v-if="company.byStage[stage.id]"
                  type="button"
                  class="drill-number"
                  :title="`Открыть список: ${company.companyName}, ${stage.name}`"
                  @click="emit('drill', cell(company, { stageId: stage.id, stageName: stage.name, total: company.byStage[stage.id]! }))"
                >
                  {{ formatCount(company.byStage[stage.id]!) }}
                </button>
                <span
                  v-else
                  class="opacity-30"
                >—</span>
              </td>
              <td
                v-if="hasOther"
                class="py-2 pr-3 text-right tabular-nums"
              >
                {{ company.otherStages ? formatCount(company.otherStages) : '—' }}
              </td>
              <td class="py-2 text-right tabular-nums">
                <button
                  type="button"
                  class="drill-number"
                  :title="`Открыть список: все сделки компании ${company.companyName}`"
                  @click="emit('drill', cell(company, { total: company.total }))"
                >
                  {{ formatCount(company.total) }}
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p
        v-if="company.unlisted > 0"
        class="mt-3 text-xs opacity-60"
      >
        Строка «{{ UNLISTED_MANAGER_LABEL }}» — разница между итогом компании и суммой строк:
        сделки без ответственного или у сотрудника, которого не нашлось среди ответственных
        (например, его сделки появились уже после того, как отчёт перечислил менеджеров).
        Стадии у них известны — итог каждой колонки портал считает отдельно, — а списка по клику
        за этими числами нет: «ответственный не из списка» фильтром не выразить.
      </p>
    </B24Card>
  </div>
</template>
