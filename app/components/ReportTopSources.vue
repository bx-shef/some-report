<script setup lang="ts">
import type { ReportDictionaries, ReportMetrics } from '~/types/report'
import { formatCount, formatMoney, formatPercent } from '~/utils/format'
import { sourceLabel } from '~/utils/labels'
import { type DrillRequest, drill } from '~/utils/drilldown'

/**
 * Топ-5 источников по количеству лидов — отдельный блок из ТЗ от 2026-09-04.
 *
 * ⚠ Это не пересчёт, а первые пять строк уже посчитанной таблицы источников (`topSources` в
 * ядре): колонки те же, что просит ТЗ, и числа обязаны совпадать с блоком 5 строка в строку —
 * включая точность процентов (`formatPercent(x, 0)`, как там). Пересчитывать здесь что-либо —
 * заводить второе место, где та же цифра может разойтись.
 */
defineProps<{ report: ReportMetrics, dictionaries: ReportDictionaries, currencyId: string }>()
const emit = defineEmits<{ drill: [DrillRequest] }>()
</script>

<template>
  <B24Card>
    <template #header>
      <h2 class="text-base font-semibold">
        Топ-5 источников по количеству лидов
      </h2>
    </template>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[720px] text-sm">
        <thead>
          <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
            <th class="py-2 pr-3 font-normal">
              Источник
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Лиды
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Брак, %
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Квалифицировано
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Конверсия в сделку
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Успешные
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Выручка
            </th>
            <th class="py-2 text-right font-normal">
              Конверсия в продажу
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in report.topSources"
            :key="row.sourceId"
            class="border-b border-[color:var(--chart-track)]"
          >
            <td class="py-2 pr-3">
              <span class="mr-2 tabular-nums opacity-50">{{ index + 1 }}.</span>{{ sourceLabel(dictionaries, row.sourceId) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              <DrillNumber
                :request="drill.bySource(row.sourceId, 'leads', sourceLabel(dictionaries, row.sourceId))"
                :total="row.leads"
                @drill="emit('drill', $event)"
              >
                {{ formatCount(row.leads) }}
              </DrillNumber>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatPercent(row.junkShare, 0) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              <DrillNumber
                :request="drill.bySource(row.sourceId, 'qualified', sourceLabel(dictionaries, row.sourceId))"
                :total="row.qualified"
                @drill="emit('drill', $event)"
              >
                {{ formatCount(row.qualified) }}
              </DrillNumber>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatPercent(row.crToDeal, 0) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              <DrillNumber
                :request="drill.bySource(row.sourceId, 'won', sourceLabel(dictionaries, row.sourceId))"
                :total="row.won"
                @drill="emit('drill', $event)"
              >
                {{ formatCount(row.won) }}
              </DrillNumber>
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatMoney(row.revenue, currencyId) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatPercent(row.crToSale, 0) }}
            </td>
          </tr>
          <tr v-if="!report.topSources.length">
            <td
              colspan="8"
              class="py-4 text-center opacity-60"
            >
              За период лидов нет
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </B24Card>
</template>
