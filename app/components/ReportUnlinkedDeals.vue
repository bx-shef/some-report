<script setup lang="ts">
import type { ReportDictionaries, UnlinkedDeals } from '~/types/report'
import { formatCount, formatMoney, formatPercent } from '~/utils/format'
import { unlinkedSourceLabel } from '~/utils/labels'
import { type DrillRequest, drill } from '~/utils/drilldown'

/**
 * Успешные сделки без связи с лидом — в разрезе источников, с суммами.
 *
 * ⚠ Зачем отдельный блок. У сделки есть `LEAD_ID`, и на боевом портале он пуст у 90 % сделок:
 * заказы из интернет-магазина лид не порождают. Это не дефект отчёта и не «ждём настройку
 * связи» — это факт о процессе клиента. Спрятать его в оговорку значило бы показать нулевую
 * выручку по лидам без объяснения; показать таблицей — значит дать руководителю увидеть, ГДЕ и
 * НА КАКИЕ деньги сделки заводятся мимо лидов.
 *
 * Решение владельца от 2026-09-04: только успешные, период — по ДАТЕ ЗАКРЫТИЯ (в остальном
 * отчёте — по дате создания), для справки: в воронку и выручку по лидам не входят. Грузится
 * фоном после основного отчёта — около минуты на месяц. Все доли посчитаны адаптером — в
 * шаблоне ни одной формулы.
 */
defineProps<{
  /** Нет, пока фоновая выборка не закончилась или упала. */
  unlinked?: UnlinkedDeals
  pending: boolean
  /** Период длинный — выборка ждёт кнопки, а не стартует сама. */
  deferred: boolean
  /** Сколько минут ждать — считает страница по длине периода; здесь только печатаем. */
  estimateMinutes: number
  error?: string
  dictionaries: ReportDictionaries
  currencyId: string
  /** В отчёте выбраны фильтры — сказать, что здесь они не действуют (решение владельца: «ты их все выводишь»). */
  filtered?: boolean
}>()

const emit = defineEmits<{ start: [], drill: [DrillRequest] }>()
</script>

<template>
  <B24Card>
    <template #header>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold">
          7. Успешные сделки без связи с лидом
        </h2>
        <span class="text-xs opacity-60">период — по дате закрытия сделки; LEAD_ID пуст; в воронку и выручку по лидам не входят</span>
        <!-- У сделки без лида нет ни менеджера лида, ни его стадии — фильтровать не по чему, и
             владелец так и решил: блок всегда показывает все сделки. Без подписи отфильтрованная
             воронка над полным блоком читалась бы как ошибка. -->
        <span
          v-if="filtered"
          class="basis-full text-xs font-medium opacity-80"
        >
          Фильтры отчёта здесь не действуют — показаны все сделки без лида.
        </span>
      </div>
    </template>

    <!-- ⚠ Оранжевая плашка — по просьбе владельца: без неё «90 % сделок без лида» читается как
         сломанный учёт, а это устройство процесса: магазин лидов не создаёт. -->
    <B24Alert
      color="air-primary-warning"
      title="Заказы из интернет-магазина лид не порождают"
      description="Такие сделки почти всегда будут без лида — это норма процесса, а не ошибка учёта. Здесь они показаны для справки: сколько успешных сделок закрыто мимо лидов и на какую сумму. В воронку лидов и выручку по лидам они не входят."
      class="mb-4"
    />

    <div
      v-if="deferred"
      class="flex flex-wrap items-center gap-3 text-sm"
    >
      <span class="opacity-70">
        Период длинный: успешных сделок без лида за него много, выборка займёт примерно
        {{ estimateMinutes }} мин. Остальной отчёт уже готов.
      </span>
      <B24Button
        size="sm"
        color="air-primary"
        label="Посчитать"
        :disabled="pending"
        @click="emit('start')"
      />
    </div>

    <p
      v-else-if="pending"
      class="text-sm opacity-70"
    >
      Считаем успешные сделки без лида… Их около 5 500 в месяц, за этот период — примерно
      {{ estimateMinutes }} мин. Остальной отчёт уже готов.
    </p>

    <B24Alert
      v-else-if="error"
      color="air-primary-alert"
      title="Не удалось прочитать сделки без лида"
      :description="error"
    />

    <template v-else-if="unlinked">
      <div class="mb-3 flex flex-wrap gap-6 text-sm">
        <div>
          <div class="text-xs opacity-60">
            Успешных без лида за период
          </div>
          <div class="text-lg font-semibold tabular-nums">
            <DrillNumber
              :request="drill.unlinked()"
              @drill="emit('drill', $event)"
            >
              {{ formatCount(unlinked.total) }}
            </DrillNumber>
          </div>
        </div>
        <div>
          <div class="text-xs opacity-60">
            Сумма
          </div>
          <div class="text-lg font-semibold tabular-nums">
            {{ formatMoney(unlinked.revenue, currencyId) }}
          </div>
        </div>
      </div>

      <p
        v-if="unlinked.unconverted > 0"
        class="mb-3 text-xs opacity-70"
      >
        Сделок в валюте без курса — суммы взяты как есть: {{ formatCount(unlinked.unconverted) }}.
      </p>

      <p
        v-if="!unlinked.rows.length"
        class="text-sm opacity-70"
      >
        За период успешных сделок без лида нет.
      </p>

      <div
        v-else
        class="overflow-x-auto"
      >
        <table class="w-full min-w-[560px] text-sm">
          <thead>
            <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
              <th class="py-2 pr-3 font-normal">
                Источник сделки
              </th>
              <th class="py-2 pr-3 text-right font-normal">
                Сделок
              </th>
              <th class="py-2 pr-3 text-right font-normal">
                Доля
              </th>
              <th class="py-2 pr-3 text-right font-normal">
                Сумма
              </th>
              <th class="py-2 text-right font-normal">
                Доля суммы
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
                <DrillNumber
                  :request="drill.unlinkedSource(row.sourceId, unlinkedSourceLabel(dictionaries, row.sourceId))"
                  @drill="emit('drill', $event)"
                >
                  {{ formatCount(row.count) }}
                </DrillNumber>
              </td>
              <td class="py-2 pr-3 text-right tabular-nums opacity-70">
                {{ formatPercent(row.share) }}
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ formatMoney(row.revenue, currencyId) }}
              </td>
              <td class="py-2 text-right tabular-nums opacity-70">
                {{ formatPercent(row.shareOfRevenue) }}
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
              <td class="py-2 pr-3 text-right tabular-nums">
                {{ formatMoney(unlinked.revenue, currencyId) }}
              </td>
              <!-- Не константа: при нулевой сумме доли строк — нули, и подвал обязан быть нулём тоже. -->
              <td class="py-2 text-right tabular-nums opacity-70">
                {{ formatPercent(unlinked.totalShareOfRevenue) }}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </template>
  </B24Card>
</template>
