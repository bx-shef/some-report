<script setup lang="ts">
import type { ReportMetrics } from '~/types/report'
import { formatCount, formatMoney, formatPercent } from '~/utils/format'
import { type DrillRequest, drill } from '~/utils/drilldown'

const props = defineProps<{ report: ReportMetrics, currencyId: string }>()
const emit = defineEmits<{ drill: [DrillRequest] }>()

/** Список за ступенью — те же условия, что у плиток сводки: ступени и плитки обязаны сходиться. */
const STAGE_DRILL: Record<string, () => DrillRequest> = {
  leads: drill.leads,
  qualified: drill.qualified,
  won: drill.wonDeals
}

const baseLabel = computed(() =>
  props.report.summary.conversionBase === 'quality-leads' ? 'от качественных лидов' : 'от лидов'
)

/**
 * Ступени воронки — ординальная шкала одного тона, а не четыре разных цвета: этапы упорядочены,
 * и разные хюэ читались бы как несвязанные категории.
 */
const STAGE_COLORS: Record<string, string> = {
  leads: 'var(--chart-1)',
  qualified: 'var(--chart-1)',
  won: 'var(--chart-3)'
}
</script>

<template>
  <B24Card class="h-full">
    <template #header>
      <h2 class="text-base font-semibold">
        2. Воронка лидов
      </h2>
    </template>
    <ol class="space-y-4">
      <li
        v-for="(stage, index) in report.funnel"
        :key="stage.key"
      >
        <div class="text-xs opacity-60">
          {{ stage.label }}
        </div>
        <div class="mt-0.5 text-xl font-semibold leading-none">
          <DrillNumber
            :request="STAGE_DRILL[stage.key]?.()"
            @drill="emit('drill', $event)"
          >
            {{ formatCount(stage.count) }}
          </DrillNumber>
        </div>
        <div
          class="mt-0.5 text-xs"
          :class="index === 0 ? 'opacity-60' : 'text-[color:var(--chart-1)]'"
        >
          {{ formatPercent(stage.share) }} {{ index === 0 ? '' : baseLabel }}
        </div>
        <MetricBar
          class="mt-2"
          :value="stage.share"
          :color="STAGE_COLORS[stage.key]"
          :label="stage.label"
        />
        <div
          v-if="index < report.funnel.length - 1"
          class="mt-3 text-center text-xs opacity-40"
          aria-hidden="true"
        >
          ↓
        </div>
      </li>
    </ol>
    <div class="mt-4 border-t border-[color:var(--chart-track)] pt-3">
      <div class="text-xs opacity-60">
        Выручка
      </div>
      <div class="mt-0.5 text-xl font-semibold leading-none">
        {{ formatMoney(report.summary.revenue, currencyId) }}
      </div>
    </div>
  </B24Card>
</template>
