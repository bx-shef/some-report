<script setup lang="ts">
import type { ReportDictionaries, UnlinkedDeals } from '~/types/report'
import { formatCount, formatPercent } from '~/utils/format'
import { unlinkedSourceLabel } from '~/utils/labels'

/**
 * Сделки без связи с лидом — в разрезе источников.
 *
 * ⚠ Зачем отдельный блок. У сделки есть `LEAD_ID`, и на боевом портале он пуст у 90 % сделок.
 * Это не дефект отчёта и не «ждём настройку связи» — это факт о процессе клиента. Спрятать его в
 * оговорку значило бы показать нулевую воронку без объяснения; показать таблицей — значит дать
 * руководителю увидеть, ГДЕ именно сделки заводятся мимо лидов. На живых данных главная строка —
 * не какой-то источник, а его отсутствие.
 *
 * Данные приходят счётчиками, строк не читаем: поэтому здесь количество и успешные, но ни выручки,
 * ни причин. Все доли посчитаны адаптером — в шаблоне ни одной формулы.
 */
defineProps<{ unlinked: UnlinkedDeals, dictionaries: ReportDictionaries }>()
</script>

<template>
  <B24Card>
    <template #header>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold">
          7. Сделки без связи с лидом
        </h2>
        <span class="text-xs opacity-60">по полю LEAD_ID сделки; источник — поле самой сделки</span>
      </div>
    </template>

    <div class="mb-3 flex flex-wrap gap-6 text-sm">
      <div>
        <div class="text-xs opacity-60">
          Без лида за период
        </div>
        <div class="text-lg font-semibold tabular-nums">
          {{ formatCount(unlinked.total) }}
        </div>
        <div class="text-xs opacity-60">
          {{ formatPercent(unlinked.shareOfAllDeals) }} всех сделок периода
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">
          Из них успешных
        </div>
        <div class="text-lg font-semibold tabular-nums">
          {{ formatCount(unlinked.won) }}
        </div>
      </div>
    </div>

    <p
      v-if="!unlinked.rows.length"
      class="text-sm opacity-70"
    >
      За период все сделки связаны с лидами.
    </p>

    <div
      v-else
      class="overflow-x-auto"
    >
      <table class="w-full min-w-[520px] text-sm">
        <thead>
          <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
            <th class="py-2 pr-3 font-normal">
              Источник сделки
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Сделок без лида
            </th>
            <th class="py-2 pr-3 text-right font-normal">
              Доля
            </th>
            <th class="py-2 text-right font-normal">
              Из них успешных
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in unlinked.rows"
            :key="row.sourceId"
            class="border-b border-[color:var(--chart-track)]"
          >
            <td class="py-2 pr-3">
              {{ unlinkedSourceLabel(dictionaries, row.sourceId) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(row.count) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums opacity-70">
              {{ formatPercent(row.share) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatCount(row.won) }}
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="font-semibold">
            <td class="py-2 pr-3">
              Итого
            </td>
            <td class="py-2 pr-3 text-right tabular-nums">
              {{ formatCount(unlinked.total) }}
            </td>
            <td class="py-2 pr-3 text-right tabular-nums opacity-70">
              {{ formatPercent(1) }}
            </td>
            <td class="py-2 text-right tabular-nums">
              {{ formatCount(unlinked.won) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </B24Card>
</template>
