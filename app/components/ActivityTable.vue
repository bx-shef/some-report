<script setup lang="ts">
import type { ActivityReport, ActivityRow, CallDirection, DeedKind } from '~/types/activity'
import { type ActivityCell, hasActivityDrill, isUnassignedRow } from '~/utils/activityDrill'
import { averageCallSeconds, totalCalls } from '~/utils/activityLoad'
import { formatCount, formatSeconds } from '~/utils/format'

/**
 * Таблица отчёта «Активность пользователей»: строка на сотрудника.
 *
 * Компонент только рисует: ни одной формулы здесь нет — всё посчитано ядром
 * (`app/utils/activityLoad.ts`), а условие списка за числом собирает страница.
 *
 * ⚠ Раскладок ДВЕ, как у матрицы отчёта 2, и по той же причине. Тринадцать столбцов в строку
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
 *
 * ⚠ Итоговая строка и столбцы длительности НЕкликабельны, и это не забытая кнопка: итог — сумма
 * ПОКАЗАННЫХ сотрудников, а тот же фильтр без условия по человеку вернул бы весь портал; за
 * длительностью же стоит не «столько записей», а сумма секунд. Список, не сходящийся с числом над
 * ним, хуже отсутствия списка (`activityDrill.ts`).
 */
const props = defineProps<{
  report: ActivityReport
}>()

const emit = defineEmits<{ drill: [{ row: ActivityRow, cell: ActivityCell, total: number }] }>()

/** Прочерк — единственное честное «мы этого не знаем». */
const DASH = '—'

/** Звонки посчитаны — их числа известны. */
const callsKnown = computed(() => props.report.callsKnown)

/** Клик по числу: наверх едет строка, что за число и сколько в нём — заголовок повторит подпись. */
function pick(row: ActivityRow, cell: ActivityCell, total: number): void {
  emit('drill', { row, cell, total })
}

const talks = (row: ActivityRow, direction?: CallDirection): ActivityCell =>
  ({ kind: 'talks', ...(direction ? { direction } : {}) })
const deed = (deedKind: DeedKind, direction?: CallDirection): ActivityCell =>
  ({ kind: 'deed', deed: deedKind, ...(direction ? { direction } : {}) })

/**
 * Есть ли за числом список — спрашиваем ЯДРО, а не решаем в разметке.
 *
 * ⚠ Правило «за чем список есть» живёт в `activityDrill.ts` рядом с тем, кто этот список
 * собирает. Выписанное здесь по клетке (а их в двух раскладках под тридцать), оно разошлось бы с
 * ядром на первом же новом столбце: число рисовалось бы кнопкой, а нагрузки под него не нашлось
 * бы — и клик не делал бы ничего.
 */
const drillable = hasActivityDrill

/** Наговорил всего — текстом: за длительностью списка нет. */
function talkTime(row: ActivityRow): string {
  return callsKnown.value ? formatSeconds(totalCalls(row).seconds) : DASH
}

/** Средний разговор строки. */
function average(row: ActivityRow): string {
  return callsKnown.value ? formatSeconds(averageCallSeconds(totalCalls(row))) : DASH
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
                <ActivityCellNumber
                  :value="totalCalls(row).count"
                  :known="callsKnown"
                  :drillable="drillable(row, talks(row), totalCalls(row).count)"
                  :title="`Разговоры · ${row.userName}`"
                  @pick="pick(row, talks(row), totalCalls(row).count)"
                />
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
                <ActivityCellNumber
                  :value="row.calls.in.count"
                  :known="callsKnown"
                  :drillable="drillable(row, talks(row, 'in'), row.calls.in.count)"
                  :title="`Входящие разговоры · ${row.userName}`"
                  @pick="pick(row, talks(row, 'in'), row.calls.in.count)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Исходящие
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.calls.out.count"
                  :known="callsKnown"
                  :drillable="drillable(row, talks(row, 'out'), row.calls.out.count)"
                  :title="`Исходящие разговоры · ${row.userName}`"
                  @pick="pick(row, talks(row, 'out'), row.calls.out.count)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Не дозвонился
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.failed"
                  :known="callsKnown"
                  :drillable="drillable(row, { kind: 'failed' }, row.failed)"
                  :title="`Не дозвонились · ${row.userName}`"
                  @pick="pick(row, { kind: 'failed' }, row.failed)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Короткие
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.tooShort"
                  :known="callsKnown"
                  :drillable="drillable(row, { kind: 'tooShort' }, row.tooShort)"
                  :title="`Короткие разговоры · ${row.userName}`"
                  @pick="pick(row, { kind: 'tooShort' }, row.tooShort)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Письма исх. / вх.
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.email.out"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('email', 'out'), row.deeds.email.out)"
                  :title="`Исходящие письма · ${row.userName}`"
                  @pick="pick(row, deed('email', 'out'), row.deeds.email.out)"
                /> / <ActivityCellNumber
                  :value="row.deeds.email.in"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('email', 'in'), row.deeds.email.in)"
                  :title="`Входящие письма · ${row.userName}`"
                  @pick="pick(row, deed('email', 'in'), row.deeds.email.in)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Встречи
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.meeting"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('meeting'), row.deeds.meeting)"
                  :title="`Встречи · ${row.userName}`"
                  @pick="pick(row, deed('meeting'), row.deeds.meeting)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Задачи
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.task"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('task'), row.deeds.task)"
                  :title="`Задачи · ${row.userName}`"
                  @pick="pick(row, deed('task'), row.deeds.task)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Просрочено
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.overdue"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'overdue' }, row.deeds.overdue)"
                  :title="`Просроченные дела · ${row.userName}`"
                  @pick="pick(row, { kind: 'overdue' }, row.deeds.overdue)"
                />
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Лидов создал
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.leads.created"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'lead', outcome: 'created' }, row.leads.created)"
                  :title="`Созданные лиды · ${row.userName}`"
                  @pick="pick(row, { kind: 'lead', outcome: 'created' }, row.leads.created)"
                />
              </dd>
            </div>
            <div class="col-span-2 flex min-w-0 items-baseline justify-between gap-2">
              <dt class="opacity-60">
                Лиды: успех / провал
              </dt>
              <dd class="shrink-0 whitespace-nowrap tabular-nums">
                <ActivityCellNumber
                  :value="row.leads.won"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'lead', outcome: 'won' }, row.leads.won)"
                  :title="`Успешно закрытые лиды · ${row.userName}`"
                  @pick="pick(row, { kind: 'lead', outcome: 'won' }, row.leads.won)"
                /> / <ActivityCellNumber
                  :value="row.leads.lost"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'lead', outcome: 'lost' }, row.leads.lost)"
                  :title="`Проваленные лиды · ${row.userName}`"
                  @pick="pick(row, { kind: 'lead', outcome: 'lost' }, row.leads.lost)"
                />
              </dd>
            </div>
          </dl>
          <p
            v-if="!row.deedsKnown"
            class="mt-2 text-xs opacity-60"
          >
            <!-- ⚠ Две РАЗНЫЕ причины прочерков, и путать их нельзя: у ничьих звонков сотрудника
                 нет вовсе, а у чужого он есть, но его не отдал `user.get`. Прежняя подпись
                 называла третью причину — «вне выбранного отдела», — которой быть НЕ МОЖЕТ:
                 под выбранным отделом такие звонки отсеивает `scopeCallsToUsers`. -->
            <template v-if="isUnassignedRow(row)">
              Это звонки без сотрудника — например, на общую линию, которые никто не поднял. Дел и
              лидов у них быть не может.
            </template>
            <template v-else>
              Дела и лиды этого сотрудника отчёт не спрашивал: его нет в списке сотрудников портала
              (например, звонок принял бот или человек вне штата), а звонки его в выборку попали.
            </template>
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
                <ActivityCellNumber
                  :value="totalCalls(row).count"
                  :known="callsKnown"
                  :drillable="drillable(row, talks(row), totalCalls(row).count)"
                  :title="`Разговоры · ${row.userName}`"
                  @pick="pick(row, talks(row), totalCalls(row).count)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.calls.in.count"
                  :known="callsKnown"
                  :drillable="drillable(row, talks(row, 'in'), row.calls.in.count)"
                  :title="`Входящие разговоры · ${row.userName}`"
                  @pick="pick(row, talks(row, 'in'), row.calls.in.count)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.calls.out.count"
                  :known="callsKnown"
                  :drillable="drillable(row, talks(row, 'out'), row.calls.out.count)"
                  :title="`Исходящие разговоры · ${row.userName}`"
                  @pick="pick(row, talks(row, 'out'), row.calls.out.count)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ talkTime(row) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ average(row) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.failed"
                  :known="callsKnown"
                  :drillable="drillable(row, { kind: 'failed' }, row.failed)"
                  :title="`Не дозвонились · ${row.userName}`"
                  @pick="pick(row, { kind: 'failed' }, row.failed)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.tooShort"
                  :known="callsKnown"
                  :drillable="drillable(row, { kind: 'tooShort' }, row.tooShort)"
                  :title="`Короткие разговоры · ${row.userName}`"
                  @pick="pick(row, { kind: 'tooShort' }, row.tooShort)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.email.out"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('email', 'out'), row.deeds.email.out)"
                  :title="`Исходящие письма · ${row.userName}`"
                  @pick="pick(row, deed('email', 'out'), row.deeds.email.out)"
                /> / <ActivityCellNumber
                  :value="row.deeds.email.in"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('email', 'in'), row.deeds.email.in)"
                  :title="`Входящие письма · ${row.userName}`"
                  @pick="pick(row, deed('email', 'in'), row.deeds.email.in)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.meeting"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('meeting'), row.deeds.meeting)"
                  :title="`Встречи · ${row.userName}`"
                  @pick="pick(row, deed('meeting'), row.deeds.meeting)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.task"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, deed('task'), row.deeds.task)"
                  :title="`Задачи · ${row.userName}`"
                  @pick="pick(row, deed('task'), row.deeds.task)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.deeds.overdue"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'overdue' }, row.deeds.overdue)"
                  :title="`Просроченные дела · ${row.userName}`"
                  @pick="pick(row, { kind: 'overdue' }, row.deeds.overdue)"
                />
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                <ActivityCellNumber
                  :value="row.leads.created"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'lead', outcome: 'created' }, row.leads.created)"
                  :title="`Созданные лиды · ${row.userName}`"
                  @pick="pick(row, { kind: 'lead', outcome: 'created' }, row.leads.created)"
                /> / <ActivityCellNumber
                  :value="row.leads.won"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'lead', outcome: 'won' }, row.leads.won)"
                  :title="`Успешно закрытые лиды · ${row.userName}`"
                  @pick="pick(row, { kind: 'lead', outcome: 'won' }, row.leads.won)"
                /> / <ActivityCellNumber
                  :value="row.leads.lost"
                  :known="row.deedsKnown"
                  :drillable="drillable(row, { kind: 'lead', outcome: 'lost' }, row.leads.lost)"
                  :title="`Проваленные лиды · ${row.userName}`"
                  @pick="pick(row, { kind: 'lead', outcome: 'lost' }, row.leads.lost)"
                />
              </td>
            </tr>
          </tbody>
          <tfoot>
            <!-- ⚠ Итоги НЕкликабельны: это сумма показанных сотрудников, а тот же фильтр без
                 условия по человеку вернул бы весь портал. См. шапку компонента. -->
            <tr class="border-t-2 border-[color:var(--chart-track)] font-semibold">
              <th
                scope="row"
                class="py-2 pr-3 text-left"
              >
                Итого
              </th>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatCount(totalCalls(report.totals).count) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatCount(report.totals.calls.in.count) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatCount(report.totals.calls.out.count) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatSeconds(totalCalls(report.totals).seconds) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatSeconds(averageCallSeconds(totalCalls(report.totals))) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatCount(report.totals.failed) : DASH }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ callsKnown ? formatCount(report.totals.tooShort) : DASH }}
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
