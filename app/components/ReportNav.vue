<script setup lang="ts">
import { APP_REPORTS, APP_HOME } from '~/config/routes'

/**
 * Переключатель отчётов в шапке каждого отчёта.
 *
 * ⚠ Запрос страницы сохраняется при переходе (`?preview=1`): вне портала он и есть признак
 * предпросмотра, и без него соседний отчёт встретил бы человека заглушкой «работает только
 * внутри Битрикс24» — ровно после того, как первый отчёт он смотрел.
 */
const route = useRoute()

/** Куда ведёт ссылка: тот же путь, тот же запрос. */
function target(path: string) {
  return { path, query: route.query }
}

function isActive(path: string): boolean {
  return route.path === path
}
</script>

<template>
  <nav
    class="flex flex-wrap items-center gap-2 text-sm"
    aria-label="Отчёты приложения"
    data-export-exclude
  >
    <NuxtLink
      :to="target(APP_HOME)"
      class="rounded-lg border border-[color:var(--chart-track)] px-2.5 py-1 hover:bg-[color:var(--chart-track)]"
    >
      Все отчёты
    </NuxtLink>
    <NuxtLink
      v-for="report in APP_REPORTS"
      :key="report.path"
      :to="target(report.path)"
      class="rounded-lg border border-[color:var(--chart-track)] px-2.5 py-1 transition-colors"
      :class="isActive(report.path) ? 'bg-[color:var(--chart-1)] text-white' : 'hover:bg-[color:var(--chart-track)]'"
      :aria-current="isActive(report.path) ? 'page' : undefined"
    >
      {{ report.title }}
    </NuxtLink>
  </nav>
</template>
