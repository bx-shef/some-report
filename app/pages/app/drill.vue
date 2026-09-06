<script setup lang="ts">
import type { DrillRow } from '~/utils/drilldown'
import type { DrillSliderPayload } from '~/utils/drillSlider'
import { formatCount, formatDate, formatMoney } from '~/utils/format'

/**
 * Детализация: список записей за числом отчёта. Страницу открывает НАСТОЯЩИЙ слайдер портала
 * (`openSliderAppPage`), решение владельца от 2026-09-06.
 *
 * ⚠ Почему отдельной страницей, а не панелью внутри отчёта. Панель b24ui жила в НАШЕМ фрейме и
 * потому накрывала только его: во весь экран портала выйти не могла, а рядом с настоящими
 * слайдерами портала читалась как панель внутри панели. Настоящий слайдер поднимает наш второй
 * фрейм поверх всего портала — и закрывается тем же жестом, что остальные слайдеры Битрикс24.
 *
 * ⚠ Прямой заход сюда бессмыслен: без параметров вызова страница не знает, что показывать. Она об
 * этом и говорит, а не рисует пустую таблицу, которую примут за «записей нет».
 */
const b24 = useB24()
const slider = usePortalSlider()
const { rows, pending, error, done, start, loadMore } = useDrillPage()

useHead({ title: 'Детализация' })

/** Нагрузка, с которой открыли фрейм. `undefined` — открыли не слайдером или параметры негодные. */
const payload = ref<DrillSliderPayload | undefined>(undefined)
/** До первого ответа портала на экране «Загрузка», а не пустой список. */
const booting = ref(true)

onMounted(async () => {
  await b24.init()
  payload.value = slider.drillPayload()
  if (payload.value) await start(payload.value)
  booting.value = false
})

/**
 * «Показано M из N»: N — то число, по которому нажали, известно без единого запроса. Без него на
 * квартале список «Лиды» — две сотни страниц, и масштаб виден только тому, кто долистал.
 */
const description = computed(() => {
  const current = payload.value
  if (!current) return undefined
  const what = current.entity === 'deal' ? 'сделок' : 'лидов'
  const shown = formatCount(rows.value.length)
  if (done.value) return `${what}: ${shown}`
  return current.total === undefined
    ? `показано ${what}: ${shown}, есть ещё`
    : `показано ${shown} из ${formatCount(current.total)} ${what}`
})

const isDeal = computed(() => payload.value?.entity === 'deal')

/** Открыть карточку в CRM — тем же слайдером портала, поверх этого. */
async function openRow(row: DrillRow): Promise<void> {
  if (!row.path) return
  await b24.openPath(row.path)
}
</script>

<template>
  <div class="min-h-screen bg-[color:var(--chart-surface)] p-4">
    <header class="mb-4">
      <h1 class="text-lg font-semibold">
        {{ payload?.title ?? 'Детализация' }}
      </h1>
      <p
        v-if="description"
        class="mt-1 text-sm opacity-70"
      >
        {{ description }}
      </p>
    </header>

    <p
      v-if="booting"
      class="py-8 text-center text-sm opacity-70"
    >
      Загрузка…
    </p>

    <!-- ⚠ Прямой заход или подделанные параметры: говорим прямо, а не рисуем пустую таблицу —
         пустая таблица читается как «записей нет», то есть как ответ на вопрос, которого не было. -->
    <B24Alert
      v-else-if="!payload"
      color="air-primary-warning"
      title="Нечего показывать"
      description="Эта страница открывается по клику на число в отчёте. Откройте отчёт и нажмите на число — список появится здесь."
    />

    <template v-else>
      <B24Alert
        v-if="error"
        color="air-primary-alert"
        title="Не удалось прочитать записи"
        :description="error"
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
          @click="loadMore()"
        >
          Показать ещё
        </B24Button>
        <span
          v-else-if="pending"
          class="text-sm opacity-70"
        >Читаем…</span>
      </div>
    </template>
  </div>
</template>
