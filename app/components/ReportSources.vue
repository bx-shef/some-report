<script setup lang="ts">
import type { ReportDictionaries, ReportMetrics } from '~/types/report'
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
              {{ formatCount(report.summary.totalLeads) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums text-red-600 dark:text-red-400">
              {{ formatCount(report.summary.junk) }} <span class="opacity-70">({{ formatPercent(report.summary.junkShare, 0) }})</span>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(report.summary.qualified) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatPercent(report.summary.qualifiedShare, 0) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(report.summary.wonDeals) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatPercent(report.summary.wonShare) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatMoney(report.summary.revenue, currencyId) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div
      v-if="report.topSources.length"
      class="mt-4 text-xs opacity-60"
    >
      Топ-5 источников по количеству лидов:
      {{ report.topSources.map(r => sourceLabel(dictionaries, r.sourceId)).join(' · ') }}
    </div>
  </B24Card>
</template>
