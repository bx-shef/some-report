<script setup lang="ts">
import type { ManagerCellRef, ManagerLoadReport } from '~/types/managers'
import { COMPANY_UNSET, companyFullLabel, pairKey } from '~/utils/managerLoad'
import { CHART_MANAGERS, CHART_SLOTS, managerChart } from '~/utils/managerChart'
import { formatCount, formatPercent } from '~/utils/format'

/**
 * Блок «Распределение»: крупная кольцевая диаграмма «менеджер → стадия» и панель «Статистика».
 *
 * Так был устроен прежний отчёт заказчика на самом портале: большое кольцо с подписями прямо в
 * секторах, столбик чисел рядом и таблица под ними. Числа берутся из того же посчитанного отчёта,
 * что и таблица: собственных формул в блоке нет — дерево строит `app/utils/managerChart.ts`, и
 * оно под тестом.
 *
 * ⚠ Компании в кольцах НЕТ: она выбирается фильтром, по одной за раз (решение владельца от
 * 2026-09-05). Разделив круг между компаниями, мы отдавали одной почти весь круг — на боевом
 * портале в сентябре это 599 сделок против одной, — и менеджеры сжимались в штриховку по краю.
 *
 * ⚠ Клик по сектору открывает ТОТ ЖЕ список, что и число в таблице: карта «ключ → клетка»
 * приходит вместе с деревом. Сектора «Остальные» и «Без ответственного» списка не имеют и потому
 * не кликабельны — число без совпадающего с ним списка в этом отчёте не кликабельно.
 */
const props = defineProps<{
  report: ManagerLoadReport
  /** Сколько всего стадий в направлении — для строки «стадий в таблице: N из M». */
  totalStages: number
  /** Подпись охвата: «в работе», «успешные»… */
  scopeLabel: string
}>()

const emit = defineEmits<{ drill: [ManagerCellRef] }>()

/**
 * Компания на экране: фильтр показывает одну, ядро отдаёт её же единственной группой.
 *
 * ⚠ Инвариант «компания ровно одна» держит `useManagerReport` (`companyIds = [companyId]`), а не
 * тип: `ManagerLoadReport.companies` остался массивом, потому что ядро и матрица умеют больше
 * одной. Вернёте сюда несколько — этот блок молча покажет первую.
 */
const company = computed(() => props.report.companies[0])

const chart = computed(() => managerChart(props.report, company.value))

/** Цвет сектора и цвет подписи на нём — по месту менеджера в кольце. */
function slot(index: number, ink = false): string {
  const number = CHART_SLOTS[index % CHART_SLOTS.length]!
  return ink ? `var(--chart-${number}-ink)` : `var(--chart-${number})`
}

/**
 * Цвета корневых секторов.
 *
 * ⚠ «Остальные» и «Без ответственного» красятся НЕ палитрой. Слотов ровно столько же, сколько
 * менеджеров в кольце, и по модулю тринадцатый сектор получил бы цвет первого — встав с ним
 * рядом, потому что круг замыкается. Отличает их отсутствие ссылки на список: сектор, за которым
 * нет списка, — не человек.
 */
function isService(key: string): boolean {
  return !(key in chart.value.refs)
}

const colorByRoot = computed(() => Object.fromEntries(chart.value.nodes.map((node, index) => [
  node.key,
  isService(node.key) ? (node.key.endsWith('|rest') ? 'var(--chart-muted-strong)' : 'var(--chart-muted)') : slot(index)
])))
const inkByRoot = computed(() => Object.fromEntries(chart.value.nodes.map((node, index) => [
  node.key,
  isService(node.key) ? 'var(--chart-muted-ink)' : slot(index, true)
])))

/**
 * Легенда — ВСЕ менеджеры компании с числами и долями, а не только попавшие в кольцо.
 *
 * ⚠ Хвост за пределами кольца в легенде остаётся: свёрнутый сектор «Остальные» отвечает на вопрос
 * «сколько их всего», а легенда — «кто именно». Без неё человек видел бы в отчёте безымянную
 * долю и шёл искать имена в таблицу, ради которой диаграмма и рисуется.
 */
const legend = computed(() => {
  const current = company.value
  return (current?.rows ?? []).map((row, index) => ({
    key: `${row.managerId}`,
    label: row.managerName,
    value: row.total,
    // ⚠ Доля берётся из ядра, а не считается здесь. Знаменатель у неё непростой (итог компании —
    // отдельный счётчик портала, а не сумма строк), и посчитанная в шаблоне доля разошлась бы с
    // таблицей по соседству ровно тогда, когда этого никто не ждёт.
    share: row.share,
    // Цвет — только у тех, кто нарисован в кольце: у остальных его в диаграмме нет, и рисовать
    // им квадратик значило бы обещать сектор, которого нет.
    color: index < CHART_MANAGERS ? slot(index) : undefined,
    // ⚠ Ссылка ищется ПО КЛЮЧУ, а не по номеру строки: в кольце первые двенадцать, а в легенде
    // все, и совпадение по индексу обрывалось бы на тринадцатом — числа легенды переставали бы
    // открывать список, хотя те же числа в таблице открывают.
    ref: current ? chart.value.refs[pairKey(current.companyId, row.managerId)] : undefined
  }))
})

function pick(key: string): void {
  const ref = chart.value.refs[key]
  if (ref) emit('drill', ref)
}

/**
 * За каждым сектором есть список — кроме свёрнутого хвоста и сделок без ответственного.
 *
 * ⚠ Считается по НАРИСОВАННЫМ узлам, а не по всем ссылкам: в `refs` лежат и менеджеры за
 * пределами кольца (их числа кликабельны в легенде), а сектора у них нет.
 */
const pickable = computed(() => chart.value.nodes
  .flatMap(node => [node.key, ...(node.children ?? []).map(child => child.key)])
  .filter(key => key in chart.value.refs))

const title = computed(() => {
  const current = company.value
  if (!current) return 'Распределение'
  return `Распределение: ${companyFullLabel(current.companyId, current.companyName)}`
})
</script>

<template>
  <B24Card>
    <template #header>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold">
          {{ title }}
        </h2>
        <span
          v-if="company && company.companyId === COMPANY_UNSET"
          class="text-xs opacity-60"
        >поле «Моя компания» у этих сделок не заполнено</span>
      </div>
    </template>

    <div class="flex flex-col gap-6 lg:flex-row lg:items-start">
      <SunburstChart
        :nodes="chart.nodes"
        :color-by-root="colorByRoot"
        :ink-by-root="inkByRoot"
        :pickable="pickable"
        :center-value="formatCount(report.total)"
        center-label="сделок"
        aria-label="Распределение сделок по менеджерам и стадиям"
        @pick="pick"
      />

      <div class="flex-1 space-y-4">
        <!-- «Статистика» — тот же столбик чисел, что стоял рядом с диаграммой в прежнем отчёте. -->
        <dl class="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <div class="rounded-lg border border-[color:var(--chart-track)] px-3 py-2">
            <dt class="text-xs uppercase tracking-wide opacity-60">
              Сделок
            </dt>
            <dd class="mt-1 text-xl font-semibold leading-none tabular-nums">
              {{ formatCount(report.total) }}
            </dd>
            <dd class="mt-1 text-xs opacity-60">
              {{ scopeLabel }}
            </dd>
          </div>
          <div class="rounded-lg border border-[color:var(--chart-track)] px-3 py-2">
            <dt class="text-xs uppercase tracking-wide opacity-60">
              Менеджеров
            </dt>
            <dd class="mt-1 text-xl font-semibold leading-none tabular-nums">
              {{ formatCount(report.managers) }}
            </dd>
            <dd class="mt-1 text-xs opacity-60">
              с хотя бы одной сделкой
            </dd>
          </div>
          <div class="rounded-lg border border-[color:var(--chart-track)] px-3 py-2">
            <dt class="text-xs uppercase tracking-wide opacity-60">
              Стадий
            </dt>
            <dd class="mt-1 text-xl font-semibold leading-none tabular-nums">
              {{ formatCount(report.stages.length) }}
            </dd>
            <dd class="mt-1 text-xs opacity-60">
              из {{ formatCount(totalStages) }} в направлении
            </dd>
          </div>
          <div class="rounded-lg border border-[color:var(--chart-track)] px-3 py-2">
            <dt class="text-xs uppercase tracking-wide opacity-60">
              Без ответственного
            </dt>
            <dd class="mt-1 text-xl font-semibold leading-none tabular-nums">
              {{ formatCount(report.unlisted) }}
            </dd>
            <dd class="mt-1 text-xs opacity-60">
              вне строк таблицы
            </dd>
          </div>
        </dl>

        <!-- Легенда с числами — обязательный второй канал идентичности рядом с цветом. -->
        <ul class="max-h-[22rem] space-y-1.5 overflow-y-auto pr-1">
          <li
            v-for="item in legend"
            :key="item.key"
            class="flex items-center gap-2 text-sm"
          >
            <span
              class="size-2.5 shrink-0 rounded-full border border-[color:var(--chart-track)]"
              :style="item.color ? { backgroundColor: item.color, borderColor: item.color } : undefined"
            />
            <span class="flex-1 truncate">{{ item.label }}</span>
            <button
              v-if="item.ref"
              type="button"
              class="drill-number tabular-nums"
              :title="`Открыть список: ${item.label}`"
              @click="emit('drill', item.ref)"
            >
              {{ formatCount(item.value) }}
            </button>
            <span
              v-else
              class="tabular-nums opacity-70"
            >{{ formatCount(item.value) }}</span>
            <span class="w-12 text-right tabular-nums opacity-60">{{ formatPercent(item.share, 0) }}</span>
          </li>
          <li
            v-if="!legend.length"
            class="text-sm opacity-60"
          >
            Под этим отбором сделок нет
          </li>
        </ul>
      </div>
    </div>
  </B24Card>
</template>
