<script setup lang="ts">
import { pageTitle } from '~/utils/pageTitle'

useHead({
  htmlAttrs: { lang: 'ru' },
  titleTemplate: title => pageTitle(title)
})

const route = useRoute()
const router = useRouter()

/**
 * Приостановка приложения при незавершённом приёме работ — ОДИН раз на всё приложение.
 *
 * ⛔ Страница не монтируется, пока решение не принято. Экран, встающий на её место ПОСЛЕ
 * монтирования, опоздал бы: дочерний `onMounted` выполняется раньше родительского, и отчёт успевал
 * сходить в CRM, а главная — сжечь одноразовое условие детализации. Подробности и цена каждой из
 * отвергнутых редакций — в `usePaymentLock.ts`.
 *
 * ⚠ Пустое ожидание видно только на страницах приложения: для публичной `/` и установщика решение
 * известно синхронно, и пререндер запекает их как прежде.
 */
const { resolved, stage, blocking, remaining, hardFrom } = usePaymentLock(route.path)

/** Стадия, пригодная для экрана: `none` он не рисует вовсе. */
const shownStage = computed(() => (stage.value === 'none' ? undefined : stage.value))

/**
 * ⛔ Ждём ГОТОВНОСТИ роутера, прежде чем читать строку запроса.
 *
 * Без ожидания обход `?lock=` молча не срабатывал: экран показывал стадию расписания вместо
 * запрошенной. Причина неочевидна и появилась ровно из-за правки выше. Пока страница монтировалась
 * сразу, `onMounted` корня выполнялся ПОСЛЕ детей — а пока дети монтировались, роутер успевал
 * закончить начальную навигацию. Теперь детей нет, корень монтируется мгновенно и видит ещё не
 * разобранный адрес: `route.query` пуст, `route.fullPath` — без строки запроса. Проверено на
 * собранной статике.
 *
 * ⚠ И `window.location.search` в этот момент ТОЖЕ пуст — подмена на него дефект не лечит.
 */
onMounted(async () => {
  await router.isReady()
  await resolvePaymentLock(route.path, route.query.lock)
})
</script>

<template>
  <B24App>
    <PaymentLockScreen
      v-if="blocking && shownStage"
      :stage="shownStage"
      :remaining="remaining"
      :hard-from="hardFrom"
    />
    <NuxtPage v-else-if="resolved" />
  </B24App>
</template>
