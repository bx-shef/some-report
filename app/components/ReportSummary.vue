<script setup lang="ts">
import type { ReportMetrics } from '~/types/report'
import { formatCount, formatMoney, formatPercent } from '~/utils/format'
import { type DrillRequest, drill } from '~/utils/drilldown'

const props = defineProps<{ report: ReportMetrics, currencyId: string }>()
const emit = defineEmits<{ drill: [DrillRequest] }>()

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
        :drill="drill.leads()"
        :drill-total="summary.totalLeads"
        @drill="emit('drill', $event)"
      />
      <StatTile
        label="Брак лидов"
        :value="formatCount(summary.junk)"
        :hint="`${formatPercent(summary.junkShare)} от лидов`"
        tone="alert"
        :drill="drill.junk()"
        :drill-total="summary.junk"
        @drill="emit('drill', $event)"
      />
      <StatTile
        label="Квалифицировано в сделку"
        :value="formatCount(summary.qualified)"
        :hint="`${formatPercent(summary.qualifiedShare)} ${baseLabel}`"
        tone="accent"
        :drill="drill.qualified()"
        :drill-total="summary.qualified"
        @drill="emit('drill', $event)"
      />
      <!-- ⚠ Контекст обязателен: на боевом портале сделок из лидов — каждая десятая. Без
           «из 6 076 всего» число 636 читается как «компания продала 636 раз за месяц». -->
      <StatTile
        label="Успешные сделки из лидов"
        :value="formatCount(summary.wonDeals)"
        :hint="summary.allDeals
          ? `${formatPercent(summary.wonShare)} ${baseLabel} · всего успешных за период по дате создания: ${formatCount(summary.allDeals.won)}; успешные без лида — блок 7, там период по дате закрытия, и с этой разницей он не сходится`
          : `${formatPercent(summary.wonShare)} ${baseLabel}`"
        tone="accent"
        :drill="drill.wonDeals()"
        :drill-total="summary.wonDeals"
        @drill="emit('drill', $event)"
      />
      <!-- ТЗ просит ОБЕ конверсии отдельными показателями. «Лид → продажа» стоит подписью
           у «Успешных сделок» выше, поэтому здесь — «лид → сделка», а не её повтор. -->
      <StatTile
        label="Конверсия лид → сделка"
        :value="formatPercent(summary.qualifiedShare)"
        :hint="`знаменатель: ${formatCount(summary.conversionBaseValue)}`"
      />
      <StatTile
        label="Выручка по лидам"
        :value="formatMoney(summary.revenue, currencyId)"
        hint="сумма успешных сделок из лидов"
      />
    </dl>
  </B24Card>
</template>
