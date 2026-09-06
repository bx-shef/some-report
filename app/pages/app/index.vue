<script setup lang="ts">
import { APP_REPORTS } from '~/config/routes'
import type { DrillRow } from '~/utils/drilldown'
import type { DrillSliderPayload } from '~/utils/drillSlider'

/**
 * Главная страница приложения: выбор отчёта. Её открывает ПЛИТКА приложения в разделе
 * «Приложения»; пункты CRM-аналитики с 2026-09-05 ведут прямо в отчёты (`app/config/b24.ts`).
 *
 * ⚠ Заглушки «работает только внутри портала» здесь нет намеренно: страница не показывает ни
 * одного числа портала, а снаружи она — оглавление, из которого понятно, что вообще умеет
 * приложение. Данные закрыты на самих отчётах, каждым своим гейтом.
 *
 * ⚠ У страницы ДВА лица, и это не «на всякий случай». Портал открывает адрес обработчика
 * приложения (`/app`) не только по плитке, но и когда мы сами просим его открыть слайдер
 * детализации (`openSliderAppPage`): маршрутизации по `place` у портала нет, `place` — просто
 * данные в `PLACEMENT_OPTIONS`. Значит, свежий фрейм слайдера приезжает СЮДА, и здесь же решается,
 * что показать — оглавление или список записей.
 */
const b24 = useB24()
const slider = usePortalSlider()
const route = useRoute()
const { rows, pending, error, done, start, loadMore } = useDrillPage()
const inPortal = ref(false)
/**
 * Проверка «мы во фрейме?» закончилась.
 *
 * ⚠ До неё не показываем НИЧЕГО, кроме «Загрузка…», — ни плашки «вне портала» (внутри портала
 * она мелькала бы на первом кадре и врала бы ровно тем, для кого приложение и сделано), ни самого
 * оглавления. Оглавление по умолчанию было хуже всего: во фрейме слайдера детализации человек
 * успевал увидеть — и нажать — плитки выбора отчёта, и слайдер уезжал на страницу отчёта вместо
 * списка, за которым его открыли.
 */
const resolved = ref(false)
/**
 * Нагрузка слайдера детализации, если фрейм открыт ею. `undefined` — обычное открытие приложения.
 *
 * ⚠ Разбор проверяющий (`drillSlider.ts`): значение приходит от портала, то есть снаружи.
 */
const drill = ref<DrillSliderPayload | undefined>(undefined)
/**
 * Фрейм открыт детализацией, а нагрузка негодная.
 *
 * ⚠ Отдельно от `drill`, потому что молчать здесь нельзя. Человек нажал на число и ждёт список;
 * показать ему вместо списка оглавление приложения — соврать так, что не поймёшь, что случилось.
 * Разбор отвергает нагрузку целиком при малейшей порче (`drillSlider.ts`), а испортить её может
 * что угодно по дороге через портал, — значит, этот исход штатный, а не «никогда не бывает».
 */
const drillBroken = ref(false)
/**
 * Почему нагрузку не удалось прочитать — короткой технической строкой под плашкой.
 *
 * ⚠ Она здесь не для красоты: отказов у разбора десяток, и по экрану они неразличимы, а чинятся
 * по-разному — обрезанная по дороге нагрузка и неразрешённое поле условия требуют
 * противоположных действий. Данных CRM в строке нет (см. `drillSlider.ts`).
 */
const drillReason = ref<string | undefined>(undefined)
/** Портал не открыл карточку: клик без последствий читается как поломка отчёта. */
const openError = ref<string | undefined>(undefined)

useHead({ title: 'Отчёты' })

/** Ссылка на отчёт с сохранением запроса: `?preview=1` вне портала и есть признак предпросмотра. */
function target(path: string) {
  return { path, query: route.query }
}

onMounted(async () => {
  await b24.init()
  inPortal.value = b24.isInit()
  // ⚠ Признак «это фрейм детализации» читается ДО await: за время чтения условия из портала
  // страница не должна успеть показать оглавление тому, кто ждёт список.
  const requested = slider.drillRequested()
  drillBroken.value = requested
  const read = await slider.readDrill()
  drill.value = read.ok ? read.payload : undefined
  drillBroken.value = requested && !read.ok
  drillReason.value = read.ok ? undefined : read.reason
  resolved.value = true
  if (drill.value) {
    await start(drill.value)
    await fit()
    return
  }
  await fit()
})

/**
 * Подогнать высоту фрейма под содержимое.
 *
 * ⚠ Портал её не знает: без этого фрейм слайдера остаётся высотой в один экран, и список не
 * долистать. То же самое делают все остальные страницы приложения.
 */
async function fit(): Promise<void> {
  await nextTick()
  await b24.fitWindow()
}

/** После каждой доклеенной страницы фрейм подрастает — иначе новым строкам некуда показаться. */
async function more(): Promise<void> {
  await loadMore()
  await fit()
}

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
  <ReportDrill
    v-if="drill"
    :payload="drill"
    :rows="rows"
    :pending="pending"
    :done="done"
    :error="error"
    :open-error="openError"
    @more="more()"
    @open="openRow"
  />

  <main
    v-else-if="!resolved"
    class="mx-auto max-w-4xl p-3 sm:p-4 lg:p-6"
  >
    <p class="text-sm opacity-70">
      Загрузка…
    </p>
  </main>

  <main
    v-else-if="drillBroken"
    class="mx-auto max-w-4xl p-3 sm:p-4 lg:p-6"
  >
    <B24Alert
      color="air-primary-alert"
      title="Список не открылся"
      description="Портал передал негодные параметры списка. Закройте это окно и нажмите на число ещё раз — если повторится, покажите строку ниже разработчику."
    />
    <p
      v-if="drillReason"
      class="mt-2 text-xs opacity-60"
    >
      {{ drillReason }}
    </p>
  </main>

  <main
    v-else
    class="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6"
  >
    <h1 class="text-xl font-bold">
      Отчёты по CRM
    </h1>

    <p class="text-sm opacity-70">
      Приложение читает лиды и сделки вашего Битрикс24 и ничего в них не меняет. Выберите отчёт.
    </p>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <NuxtLink
        v-for="report in APP_REPORTS"
        :key="report.path"
        :to="target(report.path)"
        class="block rounded-lg border border-[color:var(--chart-track)] p-4 transition-colors hover:bg-[color:var(--chart-track)]"
      >
        <h2 class="text-base font-semibold">
          {{ report.title }}
        </h2>
        <p class="mt-2 text-sm opacity-70">
          {{ report.summary }}
        </p>
      </NuxtLink>
    </div>

    <B24Alert
      v-if="!inPortal"
      color="air-primary-warning"
      title="Страница открыта вне портала"
      description="Живые данные отчёты берут только внутри Битрикс24 — из раздела «CRM-аналитика» → «Приложения». Снаружи они показывают демонстрационный набор."
    />
  </main>
</template>
