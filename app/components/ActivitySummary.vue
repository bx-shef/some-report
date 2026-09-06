<script setup lang="ts">
import type { ActivityReport } from '~/types/activity'
import { averageCallSeconds, totalCalls, totalDeeds } from '~/utils/activityLoad'
import { formatCount, formatSeconds } from '~/utils/format'

/**
 * Плитки итогов отчёта «Активность пользователей».
 *
 * Компонент только рисует: ни одной формулы здесь нет — всё посчитано ядром
 * (`app/utils/activityLoad.ts`). Плитка, посчитанная в шаблоне, не покрыта тестом и расходится с
 * таблицей по соседству ровно тогда, когда этого никто не ждёт.
 *
 * ⚠ Пока звонки читаются фоном, их плитки показывают ПРОЧЕРК, а не ноль. Ноль на экране означает
 * «не звонил», и человек, открывший отчёт в первую секунду, прочитал бы его именно так.
 */
const props = defineProps<{
  report: ActivityReport
  /** Звонки ещё читаются: их плитки пока не числа. */
  callsPending?: boolean
}>()

/** Показывать числа звонков можно, только когда они посчитаны. */
const callsReady = computed(() => props.report.callsKnown)

const tiles = computed(() => {
  const totals = props.report.totals
  const calls = totalCalls(totals)
  const dash = '—'
  return [
    {
      key: 'talks',
      label: 'Разговоров',
      value: callsReady.value ? formatCount(calls.count) : dash,
      note: callsReady.value
        ? `входящих ${formatCount(totals.calls.in.count)}, исходящих ${formatCount(totals.calls.out.count)}`
        : 'звонки ещё читаются'
    },
    {
      key: 'talk-time',
      label: 'Наговорили',
      value: callsReady.value ? formatSeconds(calls.seconds) : dash,
      note: callsReady.value
        ? `в среднем ${formatSeconds(averageCallSeconds(calls))} за разговор`
        : 'звонки ещё читаются'
    },
    {
      key: 'failed',
      label: 'Не дозвонились',
      value: callsReady.value ? formatCount(totals.failed) : dash,
      note: 'набрали номер, но разговора не вышло'
    },
    {
      key: 'too-short',
      label: 'Короткие',
      value: callsReady.value ? formatCount(totals.tooShort) : dash,
      // ⚠ Порог называем прямо здесь: без него «короткие» — это число без единицы измерения, и
      // сверить его с прежним отчётом заказчика нечем.
      note: props.report.thresholdSeconds > 0
        ? `разговор не дольше ${props.report.thresholdSeconds} с`
        : 'порог отключён — коротких нет'
    },
    {
      key: 'deeds',
      label: 'Дел в CRM',
      value: formatCount(totalDeeds(totals.deeds)),
      note: `писем ${formatCount(totals.deeds.email.in + totals.deeds.email.out)}, встреч ${formatCount(totals.deeds.meeting)}, задач ${formatCount(totals.deeds.task)}`
    },
    {
      key: 'leads',
      label: 'Лидов создано',
      value: formatCount(totals.leads.created),
      // ⚠ Закрытые считаются по дате ЗАКРЫТИЯ, а созданные — по дате создания: сходиться они не
      // обязаны, и подпись обязана это сказать, иначе расхождение читается как ошибка отчёта.
      note: `закрыто за период: успешно ${formatCount(totals.leads.won)}, провалено ${formatCount(totals.leads.lost)}`
    }
  ]
})
</script>

<template>
  <div
    class="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-6"
    data-testid="activity-summary"
  >
    <B24Card
      v-for="tile in tiles"
      :key="tile.key"
    >
      <p class="text-xs opacity-60">
        {{ tile.label }}
      </p>
      <p class="mt-1 text-2xl font-bold tabular-nums">
        {{ tile.value }}
      </p>
      <p class="mt-1 text-xs opacity-60">
        {{ tile.note }}
      </p>
    </B24Card>
  </div>
</template>
