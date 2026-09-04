<script setup lang="ts">
import type { ReportDictionaries, ReportMetrics, SourceRow } from '~/types/report'
import { conversionBaseValue, share } from '~/utils/metrics'
import { formatCount, formatMoney, formatPercent } from '~/utils/format'
import { sourceLabel } from '~/utils/labels'

const props = defineProps<{ report: ReportMetrics, dictionaries: ReportDictionaries, currencyId: string }>()

const baseLabel = computed(() =>
  props.report.summary.conversionBase === 'quality-leads'
    ? 'CR считается от лидов источника без брака'
    : 'CR считается от всех лидов источника'
)

/**
 * Полоса выручки — доля от МАКСИМУМА по колонке, а не от суммы: колонка сравнивает источники между
 * собой, и от суммы самая крупная полоса вышла бы в половину ширины, а различия между остальными
 * схлопнулись бы в неразличимые огрызки.
 */
const maxRevenue = computed(() => Math.max(0, ...props.report.bySource.map(r => r.revenue)))

/**
 * «Итого» считается по САМИМ СТРОКАМ таблицы, а не берётся из сводки.
 *
 * ⚠ Раньше строки шли из `sourceRows()`, а итог — из `summary`, и это разные множества:
 * `sourceRows()` сознательно не берёт сделки без лида-родителя (их источник неизвестен), а
 * `summary` считает все. На живом портале, где сделки заводят руками, итог не сходился со своей
 * же колонкой — и это читалось как ошибка отчёта, хотя оба числа верны.
 */
const totals = computed(() => {
  const rows = props.report.bySource
  const sum = (pick: (row: SourceRow) => number) => rows.reduce((acc, row) => acc + pick(row), 0)
  const leads = sum(row => row.leads)
  const junk = sum(row => row.junk)
  const base = conversionBaseValue(leads, junk, props.report.summary.conversionBase)
  const qualified = sum(row => row.qualified)
  const won = sum(row => row.won)
  return {
    leads,
    junk,
    junkShare: share(junk, leads),
    qualified,
    crToDeal: share(qualified, base),
    won,
    crToSale: share(won, base),
    revenue: sum(row => row.revenue)
  }
})

/**
 * ⚠ Точность процентов в строке «Итого» и в строках выше РАЗНАЯ, и это не забытая унификация.
 *
 * Строки источников читают, чтобы сравнить источники между собой: там целых процентов достаточно,
 * а дробные превращают колонку в шум. Итог — то число, которое цитируют, поэтому он печатается с
 * той же точностью, что и сводка. Округлённый до целого итог печатал «50 %» там, где сводка
 * показывала «49,6 %», — одно и то же число двумя способами на одном экране.
 *
 * ⚠ Но «та же точность» НЕ значит «всегда те же цифры», и путать это нельзя. Лиды, брак и
 * квалифицированные в итоге всегда сходятся со сводкой: у каждого лида есть строка источника.
 * А успешные сделки и выручка сойтись НЕ обязаны — разрез источников не берёт сделки без
 * лида-родителя, а сводка берёт все. Именно поэтому под таблицей стоит строка-объяснение: без
 * неё расхождение читалось бы как ошибка отчёта.
 */

/** Сделки, которых нет в разрезе источников: у них неизвестен источник (нет лида-родителя). */
const outsideSources = computed(() => ({
  revenue: props.report.summary.revenue - totals.value.revenue,
  deals: props.report.summary.wonDeals - totals.value.won
}))
</script>

<template>
  <B24Card>
    <template #header>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold">
          5. Эффективность источников лидов
        </h2>
        <span class="text-xs opacity-60">{{ baseLabel }}</span>
      </div>
    </template>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[900px] text-sm">
        <thead>
          <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
            <th class="py-2 pr-3 font-normal">
              Источник лида
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Лиды
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Брак
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Квалифицировано
            </th>
            <th class="py-2 pr-3 font-normal">
              CR лид → сделка
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Успешные продажи
            </th>
            <th class="py-2 pr-3 font-normal">
              CR лид → продажа
            </th>
            <th class="py-2 font-normal">
              Выручка
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in report.bySource"
            :key="row.sourceId"
            class="border-b border-[color:var(--chart-track)]"
          >
            <td class="py-2 pr-3">
              {{ sourceLabel(dictionaries, row.sourceId) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(row.leads) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums text-red-600 dark:text-red-400">
              {{ formatCount(row.junk) }} <span class="opacity-70">({{ formatPercent(row.junkShare, 0) }})</span>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(row.qualified) }}
            </td>
            <td class="w-32 py-2 pr-3">
              <div class="text-right text-xs tabular-nums">
                {{ formatPercent(row.crToDeal, 0) }}
              </div>
              <MetricBar
                class="mt-1"
                :value="row.crToDeal"
                label="Конверсия лид → сделка"
              />
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(row.won) }}
            </td>
            <td class="w-32 py-2 pr-3">
              <div class="text-right text-xs tabular-nums">
                {{ formatPercent(row.crToSale, 0) }}
              </div>
              <MetricBar
                class="mt-1"
                :value="row.crToSale"
                color="var(--chart-3)"
                label="Конверсия лид → продажа"
              />
            </td>
            <td class="w-40 py-2">
              <div class="text-right text-xs tabular-nums">
                {{ formatMoney(row.revenue, currencyId) }}
              </div>
              <MetricBar
                class="mt-1"
                :value="maxRevenue ? row.revenue / maxRevenue : 0"
                color="var(--chart-2)"
                label="Выручка источника"
              />
            </td>
          </tr>
          <tr v-if="!report.bySource.length">
            <td
              colspan="8"
              class="py-4 text-center opacity-60"
            >
              За период лидов нет
            </td>
          </tr>
        </tbody>
        <tfoot v-if="report.bySource.length">
          <tr class="font-semibold">
            <td class="py-2 pr-3">
              Итого
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(totals.leads) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums text-red-600 dark:text-red-400">
              {{ formatCount(totals.junk) }} <span class="opacity-70">({{ formatPercent(totals.junkShare, 0) }})</span>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(totals.qualified) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatPercent(totals.crToDeal) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(totals.won) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatPercent(totals.crToSale) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatMoney(totals.revenue, currencyId) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Расхождение со сводкой объясняем прямо в отчёте, а не оставляем читателю гадать. -->
    <p
      v-if="outsideSources.revenue > 0 || outsideSources.deals > 0"
      class="mt-4 text-xs opacity-60"
    >
      <!-- Формулировка обходит согласование с числом: «1 успешных сделок» читается как опечатка,
           а правило множественного числа ради одной строки заводить незачем. -->
      Успешных сделок без лида-родителя: {{ formatCount(outsideSources.deals) }} на
      {{ formatMoney(outsideSources.revenue, currencyId) }}. Их источник неизвестен, поэтому в эту
      таблицу они не попадают — в сводке выше они учтены.
    </p>
  </B24Card>
</template>
