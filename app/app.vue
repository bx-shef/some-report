<script setup lang="ts">
import { pageTitle } from '~/utils/pageTitle'

useHead({
  htmlAttrs: { lang: 'ru' },
  titleTemplate: title => pageTitle(title)
})

/**
 * Блокировка приложения при неподписанных актах — ОДИН раз на всё приложение.
 *
 * ⚠ Экран ЗАМЕНЯЕТ страницу, а не ложится поверх неё, и не задерживает её показ до ответа сервера.
 * Причина в статической сборке: пререндер идёт без браузера, и любое «сначала дождись настроек»
 * запекло бы в статику ПУСТУЮ страницу — а из неё потом растёт и публичная страница, и первый кадр
 * во фрейме портала. Поэтому по умолчанию рисуется отчёт, а экран встаёт на его место, когда
 * настройки приехали (это доли секунды на своём же сервере).
 *
 * ⚠ Заменяет, а не перекрывает: страница под перекрытием продолжала бы читать CRM в фоне, а при
 * жёсткой блокировке читать нечего — приложение остановлено.
 */
const { stage, blocking, remaining, hardFrom } = usePaymentLock()

/** Стадия, пригодная для экрана: `none` он не рисует вовсе. */
const shownStage = computed(() => (stage.value === 'none' ? undefined : stage.value))
</script>

<template>
  <B24App>
    <PaymentLockScreen
      v-if="blocking && shownStage"
      :stage="shownStage"
      :remaining="remaining"
      :hard-from="hardFrom"
    />
    <NuxtPage v-else />
  </B24App>
</template>
