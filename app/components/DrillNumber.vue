<script setup lang="ts">
import type { DrillRequest } from '~/utils/drilldown'

/**
 * Число, за которым можно открыть список записей. Без запроса — обычный текст: число, за
 * которым списка «тем же условием» не собрать, не притворяется ссылкой (см. `drilldown.ts`).
 */
defineProps<{ request?: DrillRequest }>()
const emit = defineEmits<{ drill: [DrillRequest] }>()
</script>

<template>
  <button
    v-if="request"
    type="button"
    class="cursor-pointer rounded underline decoration-dotted underline-offset-4 hover:text-[color:var(--chart-1)] focus-visible:outline-2 focus-visible:outline-[color:var(--chart-1)]"
    :title="`Открыть список: ${request.title}`"
    @click="emit('drill', request)"
  >
    <slot />
  </button>
  <span v-else>
    <slot />
  </span>
</template>
