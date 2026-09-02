<script setup lang="ts">
import type { ReportMetrics } from '~/types/report'
import { formatCount, formatMoney, formatPercent } from '~/utils/format'

const props = defineProps<{ report: ReportMetrics, currencyId: string }>()

const summary = computed(() => props.report.summary)

/**
 * Как назвать знаменатель словами. Именно эта подпись и снимает вопрос «80 % от чего»: без неё
 * два разных отчёта выглядят одинаково правильными.
 */
const baseLabel = computed(() =>
  summary.value.conversionBase === 'quality-leads' ? 'от качественных лидов' : 'от лидов'
)
</script>

<template>
  <B24Card>
    <template #header>
      <h2 class="text-base font-semibold">
        1. Сводка
      </h2>
    </template>
    <dl class="grid grid-cols-2 divide-y divide-[color:var(--chart-track)] sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6 lg:divide-x">
      <StatTile
        label="Лиды"
        :value="formatCount(summary.totalLeads)"
        hint="100 %"
        tone="accent"
      />
      <StatTile
        label="Брак лидов"
        :value="formatCount(summary.junk)"
        :hint="`${formatPercent(summary.junkShare)} от лидов`"
        tone="alert"
      />
      <StatTile
        label="Квалифицировано в сделку"
        :value="formatCount(summary.qualified)"
        :hint="`${formatPercent(summary.qualifiedShare)} ${baseLabel}`"
        tone="accent"
      />
      <StatTile
        label="Успешные сделки"
        :value="formatCount(summary.wonDeals)"
        :hint="`${formatPercent(summary.wonShare)} ${baseLabel}`"
        tone="accent"
      />
      <!-- ТЗ просит ОБЕ конверсии отдельными показателями. «Лид → продажа» стоит подписью
           у «Успешных сделок» выше, поэтому здесь — «лид → сделка», а не её повтор. -->
      <StatTile
        label="Конверсия лид → сделка"
        :value="formatPercent(summary.qualifiedShare)"
        :hint="`знаменатель: ${formatCount(summary.conversionBaseValue)}`"
      />
      <StatTile
        label="Выручка"
        :value="formatMoney(summary.revenue, currencyId)"
        hint="сумма успешных сделок"
      />
    </dl>
  </B24Card>
</template>
