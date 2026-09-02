<script setup lang="ts">
import type { ReportDictionaries, ReportMetrics } from '~/types/report'
import { formatCount, formatMoney, formatPercent } from '~/utils/format'
import { lossReasonLabel } from '~/utils/labels'

defineProps<{ report: ReportMetrics, dictionaries: ReportDictionaries, currencyId: string }>()
</script>

<template>
  <B24Card class="h-full">
    <template #header>
      <h2 class="text-base font-semibold">
        4. Разбивка причин проигрыша сделок
      </h2>
    </template>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="rounded-lg border border-[color:var(--chart-track)] px-4 py-3">
        <div class="text-xs uppercase tracking-wide opacity-60">
          Проигранные сделки
        </div>
        <div class="mt-1 text-2xl font-semibold leading-none">
          {{ formatCount(report.lostDeals.count) }}
        </div>
        <div class="mt-1 text-xs text-red-600 dark:text-red-400">
          {{ formatPercent(report.lostDeals.shareOfQualified) }} от квалифицированных
        </div>
      </div>
      <div class="rounded-lg border border-[color:var(--chart-track)] px-4 py-3">
        <div class="text-xs uppercase tracking-wide opacity-60">
          Сумма потерянных сделок
        </div>
        <div class="mt-1 text-2xl font-semibold leading-none">
          {{ formatMoney(report.lostDeals.lostRevenue, currencyId) }}
        </div>
      </div>
    </div>

    <div class="mt-5 overflow-x-auto">
      <table class="w-full min-w-[360px] text-sm">
        <thead>
          <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
            <th class="py-2 pr-3 font-normal">
              Причина проигрыша
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Сделок
            </th>
            <th class="py-2 text-right font-normal">
              Сумма потерянных сделок
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in report.lostDeals.byReason"
            :key="row.reasonId"
            class="border-b border-[color:var(--chart-track)]"
          >
            <td class="py-2 pr-3">
              {{ lossReasonLabel(dictionaries, row.reasonId) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(row.count) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatMoney(row.lostRevenue, currencyId) }}
            </td>
          </tr>
          <tr v-if="!report.lostDeals.byReason.length">
            <td
              colspan="3"
              class="py-4 text-center opacity-60"
            >
              За период проигранных сделок нет
            </td>
          </tr>
        </tbody>
        <tfoot v-if="report.lostDeals.byReason.length">
          <tr class="font-semibold">
            <td class="py-2 pr-3">
              Итого
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(report.lostDeals.count) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatMoney(report.lostDeals.lostRevenue, currencyId) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </B24Card>
</template>
