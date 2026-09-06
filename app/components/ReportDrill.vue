<script setup lang="ts">
import type { DrillRow } from '~/utils/drilldown'
import type { DrillSliderPayload } from '~/utils/drillSlider'
import { formatCount, formatDate, formatMoney } from '~/utils/format'

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
 * ⚠ Панель b24ui, которая была раньше, жила в НАШЕМ фрейме и потому накрывала только его: во весь
 * экран портала выйти не могла, а рядом с настоящими слайдерами читалась как панель внутри
 * панели. Решение владельца от 2026-09-06.
 */
const props = defineProps<{ payload: DrillSliderPayload }>()

const b24 = useB24()
const { rows, pending, error, done, start, loadMore } = useDrillPage()

/** Отказ портала открыть карточку: молчать нельзя — клик без последствий читается как поломка. */
const openError = ref<string | undefined>(undefined)

onMounted(async () => {
  await start(props.payload)
  await nextTick()
  // ⚠ Портал не знает высоту нашего содержимого: без этого фрейм слайдера остаётся высотой в один
  // экран, и список не долистать. То же самое делают все остальные страницы приложения.
  await b24.fitWindow()
})

/** После каждой доклеенной страницы фрейм подрастает — иначе новые строки некуда показать. */
async function more(): Promise<void> {
  await loadMore()
  await nextTick()
  await b24.fitWindow()
}

/**
 * «Показано M из N»: N — то число, по которому нажали, известно без единого запроса. Без него на
 * квартале список «Лиды» — две сотни страниц, и масштаб виден только тому, кто долистал.
 */
const description = computed(() => {
  const current = props.payload
  const what = current.entity === 'deal' ? 'сделок' : 'лидов'
  const shown = formatCount(rows.value.length)
  if (done.value) return `${what}: ${shown}`
  return current.total === undefined
    ? `показано ${what}: ${shown}, есть ещё`
    : `показано ${shown} из ${formatCount(current.total)} ${what}`
})

const isDeal = computed(() => props.payload.entity === 'deal')

/** Открыть карточку в CRM — тем же слайдером портала, поверх этого. */
async function openRow(row: DrillRow): Promise<void> {
  if (!row.path) return
  openError.value = undefined
  // ⚠ Отказ портала показываем плашкой, как и ошибку списка: клик, после которого ничего не
  // произошло, читается как поломка отчёта, а не как «портал не смог».
  if (!await b24.openPath(row.path)) {
    openError.value = 'Портал не открыл карточку — попробуйте ещё раз или откройте её из CRM.'
  }
}
</script>

<template>
  <div class="min-h-screen bg-[color:var(--chart-surface)] p-4">
    <header class="mb-4">
      <h1 class="text-lg font-semibold">
        {{ payload.title }}
      </h1>
      <p
        v-if="description"
        class="mt-1 text-sm opacity-70"
      >
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
      v-if="!rows.length && done && !pending"
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
              {{ isDeal ? 'Сделка' : 'Лид' }}
            </th>
            <th class="py-2 pr-3 font-normal">
              Дата
            </th>
            <th class="py-2 pr-3 font-normal">
              Стадия
            </th>
            <th class="py-2 pr-3 font-normal">
              Источник
            </th>
            <th class="py-2 pr-3 font-normal">
              Ответственный
            </th>
            <th
              v-if="isDeal"
              class="py-2 text-right font-normal"
            >
              Сумма
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
              <button
                type="button"
                class="drill-number"
                :title="`Открыть карточку в CRM: ${row.title}`"
                @click="openRow(row)"
              >
                {{ row.title }}
              </button>
            </td>
            <td class="py-2 pr-3 tabular-nums opacity-70">
              {{ row.when ? formatDate(row.when.slice(0, 10)) : '—' }}
            </td>
            <td class="py-2 pr-3 opacity-70">
              {{ row.stage ?? '—' }}
            </td>
            <td class="py-2 pr-3 opacity-70">
              {{ row.source ?? '—' }}
            </td>
            <td class="py-2 pr-3 opacity-70">
              {{ row.manager ?? '—' }}
            </td>
            <td
              v-if="isDeal"
              class="py-2 text-right tabular-nums"
            >
              {{ row.amount === undefined ? '—' : formatMoney(row.amount, row.currencyId ?? '') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mt-4 flex items-center gap-3">
      <B24Button
        v-if="!done"
        :loading="pending"
        color="air-secondary"
        size="sm"
        @click="more()"
      >
        Показать ещё
      </B24Button>
      <span
        v-else-if="pending"
        class="text-sm opacity-70"
      >Читаем…</span>
    </div>
  </div>
</template>
