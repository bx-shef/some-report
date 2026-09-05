<script setup lang="ts">
import type { ManagerCellRef, ManagerLoadReport } from '~/types/managers'
import { companyFullLabel, companyKey } from '~/utils/managerLoad'
import { managerChart } from '~/utils/managerChart'
import { formatCount, formatPercent } from '~/utils/format'

/**
 * Блок «Распределение»: крупная многокольцевая диаграмма «моя компания → менеджер → стадия» и
 * панель «Статистика» рядом.
 *
 * Так был устроен прежний отчёт заказчика «Незакрытые заказы» на самом портале (amCharts
 * Sunburst слева, столбик чисел справа, таблица под ними), и заказчик просил повторить именно
 * это. Числа берутся из того же посчитанного отчёта, что и таблица: собственных формул в блоке
 * нет — дерево строит `app/utils/managerChart.ts`, и оно под тестом.
 *
 * ⚠ Клик по сектору открывает ТОТ ЖЕ список, что и число в таблице: карта «ключ → клетка»
 * приходит вместе с деревом. Сектор «Остальные» (свёрнутый хвост менеджеров) списка не имеет и
 * молча ничего не делает — числа без совпадающего списка в этом отчёте не кликабельны.
 */
const props = defineProps<{
  report: ManagerLoadReport
  /** Сколько всего стадий в направлении — для строки «стадий в таблице: N из M». */
  totalStages: number
  /** Подпись охвата: «в работе», «успешные»… */
  scopeLabel: string
}>()

const emit = defineEmits<{ drill: [ManagerCellRef] }>()

/** Порядок слотов палитры фиксирован и НЕ перебирается по кругу: цвет закреплён за позицией. */
const SLOT_COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-4)']

const chart = computed(() => managerChart(props.report))

/**
 * Цвет ветки — по месту компании в списке.
 *
 * Слотов пять, а компаний в портале бывает больше: шестая и далее забирают последний слот. Цвет
 * повторяется, но не «изобретается» на ходу, а различить их помогают легенда и таблица.
 */
const colorByRoot = computed(() => {
  const out: Record<string, string> = {}
  props.report.companies.forEach((company, index) => {
    out[companyKey(company.companyId)] = SLOT_COLORS[Math.min(index, SLOT_COLORS.length - 1)]!
  })
  return out
})

/** Легенда — корни диаграммы: компания, число сделок, доля. Клик открывает список компании. */
const legend = computed(() =>
  props.report.companies.map(company => ({
    key: companyKey(company.companyId),
    label: companyFullLabel(company.companyId, company.companyName),
    value: company.total,
    share: company.share,
    color: colorByRoot.value[companyKey(company.companyId)]!
  }))
)

function pick(key: string): void {
  const ref = chart.value.refs[key]
  if (ref) emit('drill', ref)
}
</script>

<template>
  <B24Card>
    <template #header>
      <h2 class="text-base font-semibold">
        Распределение
      </h2>
    </template>

    <div class="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div class="flex flex-1 flex-col items-center gap-4 sm:flex-row sm:items-start">
        <SunburstChart
          :nodes="chart.nodes"
          :color-by-root="colorByRoot"
          :center-value="formatCount(report.total)"
          center-label="сделок"
          aria-label="Распределение сделок по «моим компаниям», менеджерам и стадиям"
          @pick="pick"
        />

        <!-- Легенда с числами — обязательный второй канал идентичности рядом с цветом. -->
        <ul class="min-w-[200px] max-w-[26rem] flex-1 space-y-2">
          <li
            v-for="item in legend"
            :key="item.key"
            class="flex items-center gap-2 text-sm"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: item.color }"
            />
            <span class="flex-1 truncate">{{ item.label }}</span>
            <button
              type="button"
              class="drill-number tabular-nums"
              :title="`Открыть список: ${item.label}`"
              @click="pick(item.key)"
            >
              {{ formatCount(item.value) }}
            </button>
            <span class="w-14 text-right tabular-nums opacity-60">{{ formatPercent(item.share, 0) }}</span>
          </li>
          <li
            v-if="!legend.length"
            class="text-sm opacity-60"
          >
            Под этим отбором сделок нет
          </li>
        </ul>
      </div>

      <!-- «Статистика» — тот же столбик чисел, что стоял рядом с диаграммой в прежнем отчёте. -->
      <dl class="grid w-full grid-cols-2 gap-3 lg:w-64 lg:grid-cols-1">
        <div class="rounded-lg border border-[color:var(--chart-track)] px-4 py-3">
          <dt class="text-xs uppercase tracking-wide opacity-60">
            Сделок
          </dt>
          <dd class="mt-1 text-2xl font-semibold leading-none tabular-nums">
            {{ formatCount(report.total) }}
          </dd>
          <dd class="mt-1 text-xs opacity-60">
            {{ scopeLabel }}
          </dd>
        </div>
        <div class="rounded-lg border border-[color:var(--chart-track)] px-4 py-3">
          <dt class="text-xs uppercase tracking-wide opacity-60">
            Менеджеров
          </dt>
          <dd class="mt-1 text-2xl font-semibold leading-none tabular-nums">
            {{ formatCount(report.managers) }}
          </dd>
          <dd class="mt-1 text-xs opacity-60">
            с хотя бы одной сделкой
          </dd>
        </div>
        <div class="rounded-lg border border-[color:var(--chart-track)] px-4 py-3">
          <dt class="text-xs uppercase tracking-wide opacity-60">
            Моих компаний
          </dt>
          <dd class="mt-1 text-2xl font-semibold leading-none tabular-nums">
            {{ formatCount(report.companyCount) }}
          </dd>
          <dd class="mt-1 text-xs opacity-60">
            поле «Моя компания» сделки
          </dd>
        </div>
        <div class="rounded-lg border border-[color:var(--chart-track)] px-4 py-3">
          <dt class="text-xs uppercase tracking-wide opacity-60">
            Стадий в таблице
          </dt>
          <dd class="mt-1 text-2xl font-semibold leading-none tabular-nums">
            {{ formatCount(report.stages.length) }}
          </dd>
          <dd class="mt-1 text-xs opacity-60">
            из {{ formatCount(totalStages) }} в направлении
          </dd>
        </div>
      </dl>
    </div>
  </B24Card>
</template>
