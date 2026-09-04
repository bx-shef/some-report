<script setup lang="ts">
import type { ReportDictionaries, ReportMetrics } from '~/types/report'
import { formatCount, formatDuration, formatPercent } from '~/utils/format'
import { leadStageLabel, sourceLabel } from '~/utils/labels'

/**
 * Обработка лидов и потери до сделки — блоки из ТЗ, которых нет на макете. Стоят рядом намеренно:
 * оба отвечают на вопрос «где лид умер, не дойдя до сделки», и порознь читаются хуже.
 *
 * Числа «обработано / не обработано» приходят сразу, счётчиками портала («обработан» — ушёл со
 * стадии «Не обработан», решение владельца от 2026-09-04). Время первого ответа, просрочка и
 * разрез по источникам требуют истории стадий — она приходит фоном минуты через две, а на
 * длинном периоде — по кнопке. Блок показывает, что именно ещё считается, а не нули.
 */
const props = withDefaults(defineProps<{
  report: ReportMetrics
  dictionaries: ReportDictionaries
  /** История стадий ещё читается. */
  pending?: boolean
  /** Период длинный — история ждёт кнопки. */
  deferred?: boolean
  /**
   * История пришла и время посчитано. Явно, а не по данным: у периода, где никто не ответил,
   * среднее тоже пусто — и без флага блок вечно говорил бы «ждёт историю стадий».
   * `undefined` — данные построчные (демо), времени ждать не нужно.
   */
  timed?: boolean
  /** Сколько минут ждать историю — считает страница по длине периода. */
  estimateMinutes?: number
  error?: string
}>(), { pending: false, deferred: false, timed: undefined, estimateMinutes: 2, error: undefined })

const emit = defineEmits<{ start: [] }>()

/**
 * Обработка лидов может отсутствовать целиком — когда нет ни счётчиков, ни строк.
 *
 * ⚠ Показать в этом случае «обработано 0 %, просрочено 100 %» значило бы выдать факт о том, что
 * данных не запрашивали, за факт о работе живых людей. Это разные утверждения, и первое клевещет.
 */
const processing = computed(() => props.report.processing)

/** Время ответа ещё не посчитано: история идёт, отложена или упала. */
const timingMissing = computed(() => processing.value !== undefined && props.timed === false)
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
      title="Обработка лидов не посчитана"
      description="Нет ни счётчиков стадий, ни истории стадий — считать не по чему. Блок молчит, чтобы не показывать «обработано 0 %» как факт о работе отдела."
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
        <!-- Норматив не задан или история ещё не пришла — прочерк, а не ноль: «в срок всё» и
             «не с чем сравнивать» — разные утверждения, и ноль соврал бы. -->
        <div class="mt-1 text-xl font-semibold leading-none">
          {{ processing.overdue === undefined ? '—' : formatCount(processing.overdue) }}
        </div>
        <div class="mt-1 text-xs opacity-60">
          {{ processing.overdue === undefined ? (timingMissing ? 'ждёт историю стадий' : 'норматив не задан') : formatPercent(processing.overdueShare ?? 0) }}
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">
          Среднее время первого ответа
        </div>
        <div class="mt-1 text-xl font-semibold leading-none">
          {{ formatDuration(processing.avgFirstResponseMinutes) }}
        </div>
        <div
          v-if="timingMissing"
          class="mt-1 text-xs opacity-60"
        >
          ждёт историю стадий
        </div>
      </div>
    </div>

    <!-- Состояние истории стадий: считаем / по кнопке / упала. Только когда времени ещё нет. -->
    <div
      v-if="processing && timingMissing"
      class="mt-4"
    >
      <div
        v-if="deferred"
        class="flex flex-wrap items-center gap-3 text-sm"
      >
        <span class="opacity-70">
          Период длинный: история стадий за него займёт примерно {{ estimateMinutes }} мин.
          Обработано и не обработано уже посчитаны, время ответа и просрочка — по кнопке.
        </span>
        <B24Button
          size="sm"
          color="air-primary"
          label="Посчитать"
          @click="emit('start')"
        />
      </div>
      <p
        v-else-if="pending"
        class="text-sm opacity-70"
      >
        Считаем время первого ответа по истории стадий… примерно {{ estimateMinutes }} мин.
        Обработано и не обработано уже посчитаны.
      </p>
      <B24Alert
        v-else-if="error"
        color="air-primary-alert"
        title="Не удалось прочитать историю стадий"
        :description="error"
      />
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
                {{ timingMissing ? 'Ждёт историю стадий' : 'Обработанных лидов нет' }}
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
          По формуле ТЗ: Всего − Брак − Квалифицировано. Лид не брак и не сконвертирован —
          открытый, ещё в работе; причин закрытия у него нет, есть стадия.
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

        <!-- Открытые лиды по стадиям — только со счётчиков портала; у демо-набора этого нет. -->
        <table
          v-if="report.preDealLoss.byStage?.length"
          class="mt-3 w-full text-sm"
        >
          <thead>
            <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
              <th class="py-1 pr-3 font-normal">
                Открытые лиды по стадии
              </th>
              <th class="py-1 text-right font-normal">
                Лидов
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in report.preDealLoss.byStage"
              :key="row.stageId"
              class="border-b border-[color:var(--chart-track)]"
            >
              <td class="py-2 pr-3">
                {{ leadStageLabel(dictionaries, row.stageId) }}
              </td>
              <td class="py-2 text-right tabular-nums">
                {{ formatCount(row.count) }}
              </td>
            </tr>
          </tbody>
        </table>
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
