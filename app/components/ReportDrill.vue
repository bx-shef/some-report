<script setup lang="ts">
import type { DrillRow } from '~/utils/drilldown'
import type { DrillSliderPayload } from '~/utils/drillSlider'
import { formatCount, formatDate, formatMoney, formatSeconds } from '~/utils/format'

/**
 * Детализация: список записей за числом отчёта — во весь НАСТОЯЩИЙ слайдер портала.
 *
 * ⚠ Почему это компонент главной страницы, а не отдельный маршрут. `openSliderAppPage` открывает
 * АДРЕС ОБРАБОТЧИКА приложения (`/app`), а не тот путь, который мы бы захотели: `place` — просто
 * данные в `PLACEMENT_OPTIONS`, маршрутизации по нему у портала нет. Соседний
 * `client-bank-alfa-by` уводит фрейм на свой маршрут глобальным мидлваром — и платит за это
 * борьбой с восстановлением адреса у пререндеренной страницы (их же комментарий: возврат из
 * мидлвара молча затирается, спасает только навигация из `onNuxtReady`). Нам этого не нужно:
 * обработчик и так открывает `/app`, и проще показать здесь нужный экран, чем никуда не уезжать
 * через два обхода Nuxt.
 *
 * ⚠ Компонент только РИСУЕТ: ни портала, ни выборки. Данные и обе операции портала (подгонка
 * высоты фрейма, открытие карточки) — на странице. Иначе рисующий компонент завёл бы знание о
 * SDK — ровно то, ради чего в этом же PR появился `useDrillEnabled`.
 *
 * ⚠ Панель b24ui, которая была раньше, жила в НАШЕМ фрейме и потому накрывала только его: во весь
 * экран портала выйти не могла, а рядом с настоящими слайдерами читалась как панель внутри
 * панели. Решение владельца от 2026-09-06.
 */
const props = defineProps<{
  payload: DrillSliderPayload
  rows: DrillRow[]
  pending: boolean
  done: boolean
  /** Список не прочитался. */
  error?: string
  /** Портал не открыл карточку: молчать нельзя — клик без последствий читается как поломка. */
  openError?: string
}>()
const emit = defineEmits<{ more: [], open: [DrillRow] }>()

/**
 * «Показано M из N»: N — то число, по которому нажали, известно без единого запроса. Без него на
 * квартале список «Лиды» — две сотни страниц, и масштаб виден только тому, кто долистал.
 */
const description = computed(() => {
  const what = ENTITY_NOUN[props.payload.entity]
  const shown = formatCount(props.rows.length)
  if (props.done) return `${what}: ${shown}`
  return props.payload.total === undefined
    ? `показано ${what}: ${shown}, есть ещё`
    : `показано ${shown} из ${formatCount(props.payload.total)} ${what}`
})

/** Чего именно «показано M из N» — родительный падеж, по одному слову на сущность. */
const ENTITY_NOUN: Record<DrillSliderPayload['entity'], string> = {
  lead: 'лидов',
  deal: 'сделок',
  activity: 'дел',
  call: 'звонков'
}

/** Как подписан первый столбец — то, по чему человек узнаёт запись. */
const TITLE_HEAD: Record<DrillSliderPayload['entity'], string> = {
  lead: 'Лид',
  deal: 'Сделка',
  activity: 'Дело',
  call: 'Номер'
}

/**
 * Подпись столбца, в котором стоит вид записи.
 *
 * ⚠ У лидов и сделок это стадия, у дел — вид и направление, у звонков — направление и то,
 * состоялся ли разговор. Столбец один, а называется по-разному: «Стадия» над словом «Исходящий»
 * читалась бы как стадия воронки, которой у звонка нет.
 */
const KIND_HEAD: Record<DrillSliderPayload['entity'], string> = {
  lead: 'Стадия',
  deal: 'Стадия',
  activity: 'Вид',
  call: 'Направление'
}

const isDeal = computed(() => props.payload.entity === 'deal')
const isCall = computed(() => props.payload.entity === 'call')
/** Источник есть только у лидов и сделок: у дела и звонка такого поля нет вовсе. */
const hasSource = computed(() => props.payload.entity === 'lead' || props.payload.entity === 'deal')
/** Последний столбец: у сделок — сумма, у звонков — длительность. */
const hasAmount = computed(() => isDeal.value || isCall.value)
/** Первая страница ещё идёт: показывать нечего, и «Показать ещё» тут — приглашение к пустоте. */
const booting = computed(() => props.pending && !props.rows.length)

const sentinel = useTemplateRef<HTMLElement>('sentinel')
let observer: IntersectionObserver | undefined

// ⚠ Конец списка показался на экране — просим следующую страницу, как это делала панель. Без
// наблюдателя «Лиды» за квартал (двести страниц по замеру в METRICS.md) листались бы двумя
// сотнями нажатий. Не чаще одной страницы за раз: композабл вторую параллельную не пустит, но и
// просить её незачем.
watch(sentinel, (el) => {
  observer?.disconnect()
  observer = undefined
  if (!el || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting) && !props.pending && !props.done) emit('more')
  })
  observer.observe(el)
}, { flush: 'post' })

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="min-h-screen bg-[color:var(--chart-surface)] p-4">
    <header class="mb-4">
      <h1 class="text-lg font-semibold">
        {{ payload.title }}
      </h1>
      <p class="mt-1 text-sm opacity-70">
        {{ description }}
      </p>
    </header>

    <B24Alert
      v-if="error"
      color="air-primary-alert"
      title="Не удалось прочитать записи"
      :description="error"
      class="mb-3"
    />

    <B24Alert
      v-if="openError"
      color="air-primary-alert"
      title="Карточка не открылась"
      :description="openError"
      class="mb-3"
    />

    <p
      v-if="booting"
      class="text-sm opacity-70"
    >
      Читаем записи…
    </p>

    <p
      v-else-if="!rows.length && done"
      class="text-sm opacity-70"
    >
      Записей нет.
    </p>

    <div
      v-else-if="rows.length"
      class="overflow-x-auto"
    >
      <table class="w-full min-w-[560px] text-sm">
        <thead>
          <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
            <th class="py-2 pr-3 font-normal">
              {{ TITLE_HEAD[payload.entity] }}
            </th>
            <th class="py-2 pr-3 font-normal">
              Дата
            </th>
            <th class="py-2 pr-3 font-normal">
              {{ KIND_HEAD[payload.entity] }}
            </th>
            <th
              v-if="hasSource"
              class="py-2 pr-3 font-normal"
            >
              Источник
            </th>
            <th class="py-2 pr-3 font-normal">
              Ответственный
            </th>
            <th
              v-if="hasAmount"
              class="py-2 text-right font-normal"
            >
              {{ isCall ? 'Длительность' : 'Сумма' }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            class="border-b border-[color:var(--chart-track)]"
          >
            <td class="py-2 pr-3">
              <!-- ⚠ Кнопкой только то, что ОТКРЫВАЕТСЯ. У дела запись-владелец может быть
                   смарт-процессом, у звонка её может не быть вовсе — карточки для них нет, и
                   кнопка, после нажатия на которую ничего не происходит, читается как поломка. -->
              <button
                v-if="row.path"
                type="button"
                class="drill-number"
                :title="`Открыть карточку в CRM: ${row.title}`"
                @click="emit('open', row)"
              >
                {{ row.title }}
              </button>
              <span v-else>{{ row.title }}</span>
            </td>
            <td class="py-2 pr-3 tabular-nums opacity-70">
              {{ row.when ? formatDate(row.when.slice(0, 10)) : '—' }}
            </td>
            <td class="py-2 pr-3 opacity-70">
              {{ row.stage ?? '—' }}
            </td>
            <td
              v-if="hasSource"
              class="py-2 pr-3 opacity-70"
            >
              {{ row.source ?? '—' }}
            </td>
            <td class="py-2 pr-3 opacity-70">
              {{ row.manager ?? '—' }}
            </td>
            <td
              v-if="hasAmount"
              class="py-2 text-right tabular-nums"
            >
              <!-- ⚠ У звонка в этом столбце СЕКУНДЫ, а не деньги: `formatMoney` напечатал бы
                   «210 » с пустой валютой, и длительность читалась бы как сумма. -->
              <template v-if="isCall">
                {{ formatSeconds(row.amount) }}
              </template>
              <template v-else>
                {{ row.amount === undefined ? '—' : formatMoney(row.amount, row.currencyId ?? '') }}
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="!done"
      class="mt-4 flex items-center gap-3"
    >
      <B24Button
        :loading="pending"
        color="air-secondary"
        size="sm"
        @click="emit('more')"
      >
        Показать ещё
      </B24Button>
      <!-- Метка для наблюдателя: показалась на экране — значит, докрутили до конца списка. -->
      <span
        ref="sentinel"
        aria-hidden="true"
      />
    </div>
  </div>
</template>
