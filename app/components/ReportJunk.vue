<script setup lang="ts">
import type { ReportDictionaries, ReportMetrics } from '~/types/report'
import { formatCount, formatPercent } from '~/utils/format'
import { junkReasonLabel } from '~/utils/labels'

const props = defineProps<{ report: ReportMetrics, dictionaries: ReportDictionaries }>()

/** Порядок слотов палитры фиксирован и НЕ перебирается по кругу: цвет закреплён за позицией. */
const SLOT_COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-4)']

const items = computed(() =>
  props.report.junkByReason.map((row, index) => ({
    key: row.reasonId,
    label: junkReasonLabel(props.dictionaries, row.reasonId),
    value: row.count,
    // Девятая и далее причина осталась бы без своего цвета — на живом портале справочник причин
    // отказа расширяют. Лишние сваливаем в последний слот, чтобы цвет не «переизобретался».
    color: SLOT_COLORS[Math.min(index, SLOT_COLORS.length - 1)]!,
    share: row.shareOfJunk
  }))
)
</script>

<template>
  <B24Card class="h-full">
    <template #header>
      <h2 class="text-base font-semibold">
        3. Разбивка брака лидов по причинам
      </h2>
    </template>

    <div class="flex flex-wrap items-center gap-6">
      <div>
        <div class="text-xs uppercase tracking-wide opacity-60">
          Брак лидов
        </div>
        <div class="mt-1 text-2xl font-semibold leading-none">
          {{ formatCount(report.summary.junk) }}
        </div>
        <div class="mt-1 text-xs text-red-600 dark:text-red-400">
          {{ formatPercent(report.summary.junkShare) }} от лидов
        </div>
      </div>

      <DonutChart
        :items="items"
        :center-value="formatCount(report.summary.junk)"
        center-label="лидов"
      />

      <!-- Легенда с числами — обязательный второй канал идентичности рядом с цветом. -->
      <ul class="min-w-[220px] flex-1 space-y-2">
        <li
          v-for="item in items"
          :key="item.key"
          class="flex items-center gap-2 text-sm"
        >
          <span
            class="size-2.5 shrink-0 rounded-full"
            :style="{ backgroundColor: item.color }"
          />
          <span class="flex-1 truncate">{{ item.label }}</span>
          <span class="tabular-nums opacity-70">{{ formatCount(item.value) }}</span>
          <span class="w-14 text-right tabular-nums opacity-60">{{ formatPercent(item.share, 0) }}</span>
        </li>
      </ul>
    </div>

    <div class="mt-5 overflow-x-auto">
      <table class="w-full min-w-[420px] text-sm">
        <thead>
          <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
            <th class="py-2 pr-3 font-normal">
              Причина брака
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Количество лидов
            </th>
            <th class="py-2 text-right font-normal">
              Доля от брака
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in report.junkByReason"
            :key="row.reasonId"
            class="border-b border-[color:var(--chart-track)]"
          >
            <td class="py-2 pr-3">
              {{ junkReasonLabel(dictionaries, row.reasonId) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(row.count) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatPercent(row.shareOfJunk, 0) }}
            </td>
          </tr>
          <tr v-if="!report.junkByReason.length">
            <td
              colspan="3"
              class="py-4 text-center opacity-60"
            >
              За период брака нет
            </td>
          </tr>
        </tbody>
        <tfoot v-if="report.junkByReason.length">
          <tr class="font-semibold">
            <td class="py-2 pr-3">
              Итого
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(report.summary.junk) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              100 %
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </B24Card>
</template>
