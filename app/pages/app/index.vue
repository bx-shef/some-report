<script setup lang="ts">
import { APP_REPORTS } from '~/config/routes'

/**
 * Главная страница приложения: выбор отчёта. Её открывает портал по пункту CRM-аналитики.
 *
 * ⚠ Заглушки «работает только внутри портала» здесь нет намеренно: страница не показывает ни
 * одного числа портала, а снаружи она — оглавление, из которого понятно, что вообще умеет
 * приложение. Данные закрыты на самих отчётах, каждым своим гейтом.
 */
const b24 = useB24()
const route = useRoute()
const inPortal = ref(false)
/**
 * Проверка «мы во фрейме?» закончилась.
 *
 * ⚠ До неё плашку «страница открыта вне портала» не показываем: внутри портала она мелькала бы
 * на первом кадре и врала бы ровно тем людям, для кого приложение и сделано.
 */
const resolved = ref(false)

useHead({ title: 'Отчёты' })

/** Ссылка на отчёт с сохранением запроса: `?preview=1` вне портала и есть признак предпросмотра. */
function target(path: string) {
  return { path, query: route.query }
}

onMounted(async () => {
  await b24.init()
  inPortal.value = b24.isInit()
  resolved.value = true
  await nextTick()
  // Портал не знает высоту нашего содержимого: без этого фрейм остаётся высотой в один экран.
  await b24.fitWindow()
})
</script>

<template>
  <main class="mx-auto max-w-4xl space-y-4 p-4 lg:p-6">
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
      v-if="resolved && !inPortal"
      color="air-primary-warning"
      title="Страница открыта вне портала"
      description="Живые данные отчёты берут только внутри Битрикс24 — из раздела «CRM-аналитика» → «Приложения». Снаружи они показывают демонстрационный набор."
    />
  </main>
</template>
