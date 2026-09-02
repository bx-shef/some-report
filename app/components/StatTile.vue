<script setup lang="ts">
/**
 * Плитка сводки: подпись, крупное число и одна строка пояснения под ним.
 *
 * ⚠ Пояснение — не украшение. Число «1 000» само по себе не говорит, от чего оно составляет
 * 80 %, а именно этот вопрос и вызвал весь разбор формул. Поэтому подпись доли обязана называть
 * знаменатель словами.
 */
withDefaults(defineProps<{
  label: string
  value: string
  /** Строка под числом: доля и от чего она считается. */
  hint?: string
  /** `accent` — синим (доля), `alert` — красным (брак и потери), иначе приглушённо. */
  tone?: 'muted' | 'accent' | 'alert'
}>(), {
  hint: undefined,
  tone: 'muted'
})
</script>

<template>
  <div class="flex flex-col items-center px-4 py-3 text-center">
    <span class="text-xs leading-tight opacity-60">{{ label }}</span>
    <!-- Пропорциональные цифры намеренно: `tabular-nums` на крупном кегле выглядит разреженным. -->
    <span class="mt-2 text-2xl font-semibold leading-none">{{ value }}</span>
    <span
      v-if="hint"
      class="mt-1.5 text-xs leading-tight"
      :class="{
        'opacity-60': tone === 'muted',
        'text-[color:var(--chart-1)]': tone === 'accent',
        'text-red-600 dark:text-red-400': tone === 'alert'
      }"
    >{{ hint }}</span>
  </div>
</template>
