<script setup lang="ts">
import type { DrillRequest } from '~/utils/drilldown'

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
  /** Список записей за числом — число становится кнопкой. Нет — просто число. */
  drill?: DrillRequest
}>(), {
  hint: undefined,
  tone: 'muted',
  drill: undefined
})
const emit = defineEmits<{ drill: [DrillRequest] }>()
</script>

<template>
  <div class="flex flex-col items-center px-4 py-3 text-center">
    <span class="text-xs leading-tight opacity-60">{{ label }}</span>
    <!-- Пропорциональные цифры намеренно: `tabular-nums` на крупном кегле выглядит разреженным. -->
    <DrillNumber
      class="mt-2 text-2xl font-semibold leading-none"
      :request="drill"
      @drill="emit('drill', $event)"
    >
      {{ value }}
    </DrillNumber>
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
