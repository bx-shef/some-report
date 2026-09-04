<script setup lang="ts">
import type { ReportDictionaries, ReportMetrics } from '~/types/report'
import { formatCount, formatDuration, formatPercent } from '~/utils/format'
import { sourceLabel } from '~/utils/labels'

/**
 * Обработка лидов и потери до сделки — блоки из ТЗ, которых нет на макете. Стоят рядом намеренно:
 * оба отвечают на вопрос «где лид умер, не дойдя до сделки», и порознь читаются хуже.
 */
const props = defineProps<{ report: ReportMetrics, dictionaries: ReportDictionaries }>()

/**
 * Обработка лидов может отсутствовать целиком — когда время первого ответа не выбиралось.
 *
 * ⚠ Показать в этом случае «обработано 0 %, просрочено 100 %» значило бы выдать факт о том, что
 * данных не запрашивали, за факт о работе живых людей. Это разные утверждения, и первое клевещет.
 */
const processing = computed(() => props.report.processing)
</script>

<template>
  <B24Card>
    <template #header>
      <h2 class="text-base font-semibold">
        6. Обработка лидов и потери до сделки
      </h2>
    </template>

    <B24Alert
      v-if="!processing"
      color="air-primary-warning"
      title="Время первого ответа не выбиралось"
      description="«Первый ответ» — перевод лида в стадию «взят в работу» (ответ заказчика). История стадий пока не выбирается, поэтому блок не считается: «обработано 0 %» выглядело бы как факт о работе отдела."
    />

    <div
      v-if="processing"
      class="grid grid-cols-2 gap-4 lg:grid-cols-4"
    >
      <div>
        <div class="text-xs opacity-60">
          Обработано
        </div>
        <div class="mt-1 text-xl font-semibold leading-none">
          {{ formatCount(processing.processed) }}
        </div>
        <div class="mt-1 text-xs text-[color:var(--chart-1)]">
          {{ formatPercent(processing.processedShare) }}
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">
          Не обработано
        </div>
        <div class="mt-1 text-xl font-semibold leading-none">
          {{ formatCount(processing.unprocessed) }}
        </div>
        <div class="mt-1 text-xs text-red-600 dark:text-red-400">
          {{ formatPercent(processing.unprocessedShare) }}
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">
          Просрочено
        </div>
        <!-- Норматив не задан — печатаем прочерк, а не ноль: «в срок всё» и «не с чем сравнивать»
             это разные утверждения, и ноль соврал бы. -->
        <div class="mt-1 text-xl font-semibold leading-none">
          {{ processing.overdue === undefined ? '—' : formatCount(processing.overdue) }}
        </div>
        <div class="mt-1 text-xs opacity-60">
          {{ processing.overdue === undefined ? 'норматив не задан' : formatPercent(processing.overdueShare ?? 0) }}
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">
          Среднее время первого ответа
        </div>
        <div class="mt-1 text-xl font-semibold leading-none">
          {{ formatDuration(processing.avgFirstResponseMinutes) }}
        </div>
      </div>
    </div>

    <div
      v-if="processing"
      class="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2"
    >
      <div>
        <h3 class="text-sm font-semibold">
          Среднее время ответа по источникам
        </h3>
        <table class="mt-2 w-full text-sm">
          <tbody>
            <tr
              v-for="row in processing.bySource"
              :key="row.sourceId"
              class="border-b border-[color:var(--chart-track)]"
            >
              <td class="py-2 pr-3">
                {{ sourceLabel(dictionaries, row.sourceId) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums opacity-70">
                {{ formatCount(row.processed) }}
              </td>
              <td class="py-2 text-right tabular-nums">
                {{ formatDuration(row.avgFirstResponseMinutes) }}
              </td>
            </tr>
            <tr v-if="!processing.bySource.length">
              <td
                colspan="3"
                class="py-4 text-center opacity-60"
              >
                Обработанных лидов нет
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <h3 class="text-sm font-semibold">
          Потери до сделки
        </h3>
        <p class="mt-1 text-xs opacity-60">
          По формуле ТЗ: Всего − Брак − Квалифицировано.
        </p>
        <dl class="mt-2 space-y-2 text-sm">
          <div class="flex items-baseline justify-between border-b border-[color:var(--chart-track)] pb-2">
            <dt>Не дошли до сделки</dt>
            <dd class="tabular-nums font-semibold">
              {{ formatCount(report.preDealLoss.count) }}
              <span class="ml-1 font-normal opacity-60">{{ formatPercent(report.preDealLoss.share) }}</span>
            </dd>
          </div>
          <div class="flex items-baseline justify-between border-b border-[color:var(--chart-track)] pb-2">
            <dt>из них ещё в работе</dt>
            <dd class="tabular-nums">
              {{ formatCount(report.preDealLoss.stillInWork) }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between">
            <dt>из них закрыты без сделки</dt>
            <dd class="tabular-nums">
              {{ formatCount(report.preDealLoss.closedWithoutDeal) }}
            </dd>
          </div>
        </dl>
        <!-- Разложение не косметическое: формула ТЗ считает потерей и лид, который ещё в работе,
             а на коротком периоде таких большинство. -->
        <p
          v-if="report.preDealLoss.stillInWork"
          class="mt-3 text-xs opacity-60"
        >
          Лиды «ещё в работе» формула ТЗ засчитывает в потери. На коротком периоде это заметно
          завышает потери — смотрите строку разложения.
        </p>
      </div>
    </div>
  </B24Card>
</template>
