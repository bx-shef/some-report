<script setup lang="ts">
import type { ActivityReport, ActivityRow } from '~/types/activity'
import { averageCallSeconds, totalCalls } from '~/utils/activityLoad'
import { formatCount, formatSeconds } from '~/utils/format'

/**
 * Таблица отчёта «Активность пользователей»: строка на сотрудника.
 *
 * Компонент только рисует: ни одной формулы здесь нет — всё посчитано ядром
 * (`app/utils/activityLoad.ts`).
 *
 * ⚠ Раскладок ДВЕ, как у матрицы отчёта 2, и по той же причине. Одиннадцать столбцов в строку
 * требуют около 900 пикселей, на телефоне их 390: от таблицы был бы виден один столбец
 * «Сотрудник», а числа уезжали бы за край. До `lg` — карточка на сотрудника, с `lg` — таблица; она
 * прокручивается ВНУТРИ карточки, а не растягивает страницу (горизонтальный скролл всей страницы
 * во фрейме портала прячет часть отчёта под край окна).
 *
 * ⚠ Числа звонков, пока они не прочитаны, показываются ПРОЧЕРКОМ, а не нулём: ноль читается как
 * «не звонил». То же и с делами строки, которых отчёт не спрашивал (`deedsKnown: false`).
 *
 * ⚠ В карточке подпись ПЕРЕНОСИТСЯ, а число — нет. Наоборот было хуже обоих вариантов: «2 ч 14
 * мин» уезжало на вторую строку и карточка росла вдвое, а обрезка подписи давала нечитаемое
 * «Нагово…». Перенос подписи стоит одной лишней строки там, где она длинная.
 */
const props = defineProps<{
  report: ActivityReport
}>()

/** Прочерк — единственное честное «мы этого не знаем». */
const DASH = '—'

/** Звонки посчитаны — можно печатать числа. */
const callsKnown = computed(() => props.report.callsKnown)

/** Число звонка: до прихода телефонии — прочерк. */
function callNumber(value: number): string {
  return callsKnown.value ? formatCount(value) : DASH
}

/** Число дела: у строки, которую отчёт не спрашивал, — прочерк. */
function deedNumber(row: ActivityRow, value: number): string {
  return row.deedsKnown ? formatCount(value) : DASH
}

/** Средний разговор строки. */
function average(row: ActivityRow): string {
  return callsKnown.value ? formatSeconds(averageCallSeconds(totalCalls(row))) : DASH
}

/** Наговорил всего. */
function talkTime(row: ActivityRow): string {
  return callsKnown.value ? formatSeconds(totalCalls(row).seconds) : DASH
}

/**
 * Полоса под строкой — по числу разговоров относительно самого разговорчивого.
 *
 * Считается один раз на таблицу, а не в каждой строке: строк сотни, и вызов из шаблона повторялся
 * бы на каждую перерисовку.
 */
const peak = computed(() => props.report.rows.reduce((max, row) => Math.max(max, totalCalls(row).count), 0))

function barWidth(row: ActivityRow): string {
  if (!callsKnown.value || peak.value <= 0) return '0%'
  return `${Math.round((totalCalls(row).count / peak.value) * 100)}%`
}
</script>

<template>
  <B24Card>
    <p
      v-if="!report.rows.length"
      class="py-6 text-center text-sm opacity-70"
    >
      Под этим отбором сотрудников нет.
    </p>

    <template v-else>
      <!-- Телефон: карточка на сотрудника. Горизонтальной прокрутки здесь нет намеренно. -->
      <ul
        class="space-y-3 lg:hidden"
        data-testid="activity-cards"
      >
        <li
          v-for="row in report.rows"
          :key="row.userId"
          class="rounded-lg border border-[color:var(--chart-track)] p-3"
        >
          <p class="flex flex-wrap items-baseline gap-x-2 font-semibold">
            {{ row.userName }}
            <B24Badge
              v-if="row.dismissed"
              color="air-primary-warning"
              size="xs"
              label="уволен"
            />
          </p>
          <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Разговоров
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ callNumber(totalCalls(row).count) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Наговорил
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ talkTime(row) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Входящие
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ callNumber(row.calls.in.count) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Исходящие
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ callNumber(row.calls.out.count) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Не дозвонился
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ callNumber(row.failed) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Короткие
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ callNumber(row.tooShort) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Письма
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ deedNumber(row, row.deeds.email.out) }} / {{ deedNumber(row, row.deeds.email.in) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Встречи
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ deedNumber(row, row.deeds.meeting) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Задачи
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ deedNumber(row, row.deeds.task) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Просрочено
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ deedNumber(row, row.deeds.overdue) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Лидов создал
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ deedNumber(row, row.leads.created) }}
              </dd>
            </div>
            <div class="col-span-2 flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Лиды: успех / провал
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                {{ deedNumber(row, row.leads.won) }} / {{ deedNumber(row, row.leads.lost) }}
              </dd>
            </div>
          </dl>
          <p
            v-if="!row.deedsKnown"
            class="mt-2 text-xs opacity-60"
          >
            Дела и лиды этого сотрудника отчёт не спрашивал: он вне выбранного отдела, а звонки его
            попали в выборку.
          </p>
        </li>
      </ul>

      <!-- Экран: таблица. Прокрутка живёт внутри карточки, а не у всей страницы. -->
      <div class="hidden overflow-x-auto lg:block">
        <table class="w-full min-w-[64rem] text-sm">
          <caption class="sr-only">
            Активность сотрудников за период
          </caption>
          <thead>
            <tr class="border-b border-[color:var(--chart-track)] text-left align-bottom">
              <th
                scope="col"
                class="py-2 pr-3 font-medium"
              >
                Сотрудник
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Разговоров
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Вход.
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Исход.
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Наговорил
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Средний
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Не дозв.
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Короткие
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Письма<br><span class="text-xs opacity-60">исх. / вх.</span>
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Встречи
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Задачи
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Просроч.
              </th>
              <th
                scope="col"
                class="py-2 pr-3 text-right font-medium"
              >
                Лиды<br><span class="text-xs opacity-60">созд. / усп. / пров.</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in report.rows"
              :key="row.userId"
              class="border-b border-[color:var(--chart-track)]/50"
            >
              <th
                scope="row"
                class="max-w-[16rem] py-2 pr-3 text-left font-normal"
              >
                <span class="flex flex-wrap items-baseline gap-x-2">
                  <span class="truncate">{{ row.userName }}</span>
                  <B24Badge
                    v-if="row.dismissed"
                    color="air-primary-warning"
                    size="xs"
                    label="уволен"
                  />
                </span>
                <span
                  class="mt-1 block h-1 rounded-full bg-[color:var(--chart-1)]"
                  :style="{ width: barWidth(row) }"
                  aria-hidden="true"
                />
              </th>
              <td class="py-2 pr-3 text-right font-semibold tabular-nums">
                {{ callNumber(totalCalls(row).count) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(row.calls.in.count) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(row.calls.out.count) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ talkTime(row) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ average(row) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(row.failed) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(row.tooShort) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ deedNumber(row, row.deeds.email.out) }} / {{ deedNumber(row, row.deeds.email.in) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ deedNumber(row, row.deeds.meeting) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ deedNumber(row, row.deeds.task) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ deedNumber(row, row.deeds.overdue) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ deedNumber(row, row.leads.created) }} / {{ deedNumber(row, row.leads.won) }} / {{ deedNumber(row, row.leads.lost) }}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="border-t-2 border-[color:var(--chart-track)] font-semibold">
              <th
                scope="row"
                class="py-2 pr-3 text-left"
              >
                Итого
              </th>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(totalCalls(report.totals).count) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(report.totals.calls.in.count) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(report.totals.calls.out.count) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatSeconds(totalCalls(report.totals).seconds) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatSeconds(averageCallSeconds(totalCalls(report.totals))) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(report.totals.failed) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callNumber(report.totals.tooShort) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ formatCount(report.totals.deeds.email.out) }} / {{ formatCount(report.totals.deeds.email.in) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ formatCount(report.totals.deeds.meeting) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ formatCount(report.totals.deeds.task) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ formatCount(report.totals.deeds.overdue) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ formatCount(report.totals.leads.created) }} / {{ formatCount(report.totals.leads.won) }} / {{ formatCount(report.totals.leads.lost) }}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p class="mt-3 text-xs opacity-60">
        Дела и лиды посчитаны по дате создания, кроме столбца «Просроч.»: там — не выполненные дела,
        срок которых истёк к концу периода, без нижней границы. Лиды «успех» и «провал» считаются по
        дате ЗАКРЫТИЯ, поэтому с «созд.» они сходиться не обязаны.
      </p>
    </template>
  </B24Card>
</template>
