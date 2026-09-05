<script setup lang="ts">
import type { DrillRequest } from '~/utils/drilldown'

/**
 * Число, за которым можно открыть список записей. Без запроса — обычный текст: число, за
 * которым списка «тем же условием» не собрать, не притворяется ссылкой (см. `drilldown.ts`).
 */
const props = defineProps<{
  request?: DrillRequest
  /** Само число — уходит в запрос, чтобы слайдер сказал «показано M из N» до конца списка. */
  total?: number
}>()
const emit = defineEmits<{ drill: [DrillRequest] }>()

function open(): void {
  if (!props.request) return
  emit('drill', props.total === undefined ? props.request : { ...props.request, total: props.total })
}
</script>

<template>
  <button
    v-if="request"
    type="button"
    class="drill-number"
    :title="`Открыть список: ${request.title}`"
    @click="open"
  >
    <slot />
  </button>
  <span v-else>
    <slot />
  </span>
</template>
