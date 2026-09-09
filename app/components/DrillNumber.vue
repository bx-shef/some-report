<script setup lang="ts">
import type { DrillRequest } from '~/utils/drilldown'

/**
 * Число, за которым можно открыть список записей. Без запроса — обычный текст: число, за
 * которым списка «тем же условием» не собрать, не притворяется ссылкой (см. `drilldown.ts`).
 *
 * ⚠ ВНЕ ПОРТАЛА число тоже обычный текст (решение владельца от 2026-09-06). Список открывает
 * настоящий слайдер Битрикс24, а вне фрейма его не существует: кнопка, которая заведомо ничего не
 * сделает, — обещание, которого экран не может сдержать. Демо-страница показывает устройство
 * отчёта, а не работающую детализацию.
 */
const props = defineProps<{
  request?: DrillRequest
  /** Само число — уходит в запрос, чтобы слайдер сказал «показано M из N» до конца списка. */
  total?: number
  /**
   * ПОЧЕМУ за этим числом нет списка — подсказкой при наведении.
   *
   * ⚠ Только там, где причина зависит от выбора человека и он может её снять (слишком длинный
   * период). Числам, за которыми списка нет по устройству отчёта («источник не указан» —
   * остаток арифметики), подсказка не нужна: снять эту причину человек не может, и подпись
   * превратилась бы в шум на каждой второй ячейке.
   */
  unavailableHint?: string
}>()
const emit = defineEmits<{ drill: [DrillRequest] }>()

const drillEnabled = useDrillEnabled()
/** Кликабельно только там, где список есть чем открыть, — то есть внутри портала. */
const clickable = computed(() => Boolean(props.request) && drillEnabled.value)
/** Подсказка кнопки. Считается здесь, а не в шаблоне: там пришлось бы утверждать, что запрос есть. */
const hint = computed(() => props.request ? `Открыть список: ${props.request.title}` : undefined)

function open(): void {
  if (!props.request) return
  emit('drill', props.total === undefined ? props.request : { ...props.request, total: props.total })
}
</script>

<template>
  <button
    v-if="clickable"
    type="button"
    class="drill-number"
    :title="hint"
    @click="open"
  >
    <slot />
  </button>
  <!-- ⚠ Подсказка ставится только вместе с текстом причины: пустой `title` в некоторых браузерах
       показывает пустую рамку, и число выглядело бы сломанным. -->
  <span
    v-else
    :title="clickable ? undefined : unavailableHint"
  >
    <slot />
  </span>
</template>
