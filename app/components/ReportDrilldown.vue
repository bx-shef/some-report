<script setup lang="ts">
import type { DrillRequest, DrillRow } from '~/utils/drilldown'
import { formatCount, formatDate, formatMoney } from '~/utils/format'

/**
 * Слайдер детализации: список записей за числом отчёта, страницами, со ссылками в CRM.
 *
 * Решение владельца от 2026-09-04 (п. 10): «клик — открыл слайдер от Bitrix24 UI — и там по ID
 * подгрузи что нужно». Подгрузка — по мере прокрутки (наблюдатель за концом списка) и кнопкой:
 * наблюдатель не срабатывает, когда первая страница короче окна, а кнопка — всегда.
 *
 * ⚠ Ссылки в CRM ведут в портал того, кто смотрит, под его правами: карточка, которой он не
 * видит, откроется как «нет доступа» — это правда портала, а не ошибка отчёта. В демо-режиме
 * карточек нет, и слайдер говорит об этом, а не показывает мёртвые ссылки.
 */
const props = defineProps<{
  request?: DrillRequest
  rows: DrillRow[]
  pending: boolean
  error?: string
  done: boolean
  isDemo: boolean
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ more: [], openRow: [DrillRow] }>()

const isDeal = computed(() => props.request?.entity === 'deal')
const description = computed(() => {
  if (!props.request) return undefined
  const what = isDeal.value ? 'сделок' : 'лидов'
  return props.done ? `${what}: ${formatCount(props.rows.length)}` : `показано ${what}: ${formatCount(props.rows.length)}, есть ещё`
})

const sentinel = useTemplateRef<HTMLElement>('sentinel')
let observer: IntersectionObserver | undefined

// Конец списка показался на экране — просим следующую страницу. Не чаще одной за раз: сам
// композабл вторую параллельную страницу не пустит, но и просить её незачем.
watch([sentinel, open], ([el, isOpen]) => {
  observer?.disconnect()
  observer = undefined
  if (!el || !isOpen || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting) && !props.pending && !props.done) emit('more')
  })
  observer.observe(el)
}, { flush: 'post' })

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <B24Slideover
    v-model:open="open"
    :title="request?.title ?? 'Детализация'"
    :description="description"
    side="right"
    :b24ui="{ content: 'sm:max-w-[760px]', body: 'scrollbar-thin' }"
  >
    <template #body>
      <p
        v-if="isDemo"
        class="mb-3 text-xs opacity-70"
      >
        Демонстрационный набор: записи вымышленные, карточек в CRM у них нет.
      </p>

      <B24Alert
        v-if="error"
        color="air-primary-alert"
        title="Не удалось прочитать записи"
        :description="error"
        class="mb-3"
      />

      <p
        v-if="!rows.length && done && !pending"
        class="text-sm opacity-70"
      >
        Записей нет.
      </p>

      <div
        v-else-if="rows.length"
        class="overflow-x-auto"
      >
        <table class="w-full min-w-[560px] text-sm">
          <thead>
            <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
              <th class="py-2 pr-3 font-normal">
                {{ isDeal ? 'Сделка' : 'Лид' }}
              </th>
              <th class="py-2 pr-3 font-normal">
                Дата
              </th>
              <th class="py-2 pr-3 font-normal">
                {{ isDeal ? 'Стадия' : 'Стадия лида' }}
              </th>
              <th class="py-2 pr-3 font-normal">
                Источник
              </th>
              <th class="py-2 pr-3 font-normal">
                Ответственный
              </th>
              <th
                v-if="isDeal"
                class="py-2 text-right font-normal"
              >
                Сумма
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.id"
              class="border-b border-[color:var(--chart-track)]"
            >
              <td class="py-2 pr-3">
                <button
                  v-if="row.path"
                  type="button"
                  class="cursor-pointer text-left text-[color:var(--chart-1)] underline decoration-dotted underline-offset-4"
                  :title="`Открыть в CRM: ${row.title}`"
                  @click="emit('openRow', row)"
                >
                  {{ row.title }}
                </button>
                <span v-else>{{ row.title }}</span>
              </td>
              <td class="py-2 pr-3 whitespace-nowrap tabular-nums">
                {{ row.when ? formatDate(row.when.slice(0, 10)) : '—' }}
              </td>
              <td class="py-2 pr-3">
                {{ row.stage ?? '—' }}
              </td>
              <td class="py-2 pr-3">
                {{ row.source ?? '—' }}
              </td>
              <td class="py-2 pr-3">
                {{ row.manager ?? '—' }}
              </td>
              <td
                v-if="isDeal"
                class="py-2 text-right tabular-nums whitespace-nowrap"
              >
                {{ row.amount === undefined ? '—' : formatMoney(row.amount, row.currencyId ?? '') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        ref="sentinel"
        aria-hidden="true"
      />

      <div
        v-if="!done"
        class="mt-3 flex items-center gap-3"
      >
        <B24Button
          size="sm"
          color="air-secondary-no-accent"
          :label="pending ? 'Читаем…' : 'Показать ещё'"
          :disabled="pending"
          @click="emit('more')"
        />
        <span class="text-xs opacity-60">по {{ 50 }} записей за раз</span>
      </div>
    </template>
  </B24Slideover>
</template>
