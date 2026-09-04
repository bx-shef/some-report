<script setup lang="ts">
import type { ReportDictionaries, ReportFilters } from '~/types/report'
import { hasFilters } from '~/utils/filters'

/**
 * Панель фильтров (ТЗ от 2026-09-04): источник, менеджер, стадия лида, причина закрытия лида,
 * причина проигрыша сделки. Панель только собирает выбор; что он значит для запросов к порталу
 * и для строк демо-набора — `app/utils/filters.ts`.
 *
 * ⚠ «Стадия лида» и «причина закрытия лида» — одно поле `STATUS_ID`. Выбор одного снимает
 * другое: два условия на одно поле дали бы пустой отчёт без единого объяснения на экране.
 *
 * ⚠ Менеджер — ответственный ЛИДА (решение владельца от 2026-09-04). Список сотрудников
 * приходит с портала по праву `user_brief`; без списка выбор закрыт, и подпись говорит почему.
 */
const props = defineProps<{
  dictionaries: ReportDictionaries
  /** Пока идёт выборка, фильтры не меняют: каждая смена — новый запрос к порталу. */
  disabled?: boolean
}>()

const model = defineModel<ReportFilters>({ default: () => ({}) })

interface Option<T extends string | number> { id: T, label: string }

/** Словарь → варианты по алфавиту: справочники портала приходят в порядке CRM, а глазами ищут по имени. */
function toOptions(dictionary: Record<string, string> | undefined): Option<string>[] {
  return Object.entries(dictionary ?? {})
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
}

const sources = computed(() => toOptions(props.dictionaries.sources))
const users = computed<Option<number>[]>(() => toOptions(props.dictionaries.users).map(o => ({ id: Number(o.id), label: o.label })))
const stages = computed(() => toOptions(props.dictionaries.leadStages))
const junkReasons = computed(() => toOptions(props.dictionaries.junkReasons))
const lossReasons = computed(() => toOptions(props.dictionaries.lossReasons))

/** Выбор из списка: «очистить» присылает `null`, отсутствие фильтра — ключа в объекте нет вовсе. */
function pick(key: keyof ReportFilters, value: unknown): void {
  const kept = Object.fromEntries(Object.entries(model.value).filter(([k]) => k !== key)) as ReportFilters
  const empty = value === null || value === undefined || value === ''
  const next: ReportFilters = empty ? kept : { ...kept, [key]: value }
  if (key === 'junkReasonId' && next.junkReasonId) delete next.leadStatusId
  if (key === 'leadStatusId' && next.leadStatusId) delete next.junkReasonId
  model.value = next
}

function reset(): void {
  model.value = {}
}

const active = computed(() => hasFilters(model.value))
</script>

<template>
  <div
    role="group"
    aria-label="Фильтры отчёта"
    class="flex flex-wrap items-center gap-2"
  >
    <span class="text-xs opacity-60">Фильтры:</span>
    <B24SelectMenu
      :model-value="model.sourceId"
      :items="sources"
      value-key="id"
      label-key="label"
      placeholder="Источник"
      aria-label="Источник"
      size="sm"
      clear
      :search-input="false"
      :disabled="disabled"
      class="w-44"
      @update:model-value="pick('sourceId', $event)"
    />
    <B24SelectMenu
      :model-value="model.assignedById"
      :items="users"
      value-key="id"
      label-key="label"
      :placeholder="users.length ? 'Менеджер' : 'Менеджер: список сотрудников недоступен'"
      aria-label="Менеджер"
      size="sm"
      clear
      :search-input="{ placeholder: 'Найти сотрудника' }"
      :disabled="disabled || !users.length"
      class="w-52"
      @update:model-value="pick('assignedById', $event)"
    />
    <B24SelectMenu
      :model-value="model.leadStatusId"
      :items="stages"
      value-key="id"
      label-key="label"
      placeholder="Стадия лида"
      aria-label="Стадия лида"
      size="sm"
      clear
      :search-input="false"
      :disabled="disabled"
      class="w-44"
      @update:model-value="pick('leadStatusId', $event)"
    />
    <B24SelectMenu
      :model-value="model.junkReasonId"
      :items="junkReasons"
      value-key="id"
      label-key="label"
      placeholder="Причина закрытия лида"
      aria-label="Причина закрытия лида"
      size="sm"
      clear
      :search-input="false"
      :disabled="disabled"
      class="w-52"
      @update:model-value="pick('junkReasonId', $event)"
    />
    <B24SelectMenu
      :model-value="model.lossReasonKey"
      :items="lossReasons"
      value-key="id"
      label-key="label"
      placeholder="Причина проигрыша сделки"
      aria-label="Причина проигрыша сделки"
      size="sm"
      clear
      :search-input="false"
      :disabled="disabled"
      class="w-56"
      @update:model-value="pick('lossReasonKey', $event)"
    />
    <B24Button
      v-if="active"
      size="sm"
      color="air-secondary-no-accent"
      label="Сбросить"
      :disabled="disabled"
      @click="reset"
    />
    <!-- Три правила, которые иначе читаются как ошибки отчёта: сделки «менеджера» — из его
         лидов; выбор стадии молча снял причину закрытия; исчезло сравнение со всеми сделками. -->
    <p
      v-if="active"
      class="basis-full text-xs opacity-60"
    >
      Менеджер — ответственный лида: сделки под фильтром — из его лидов. Стадия лида и причина
      закрытия — одно поле: выбор одного снимает другое. Блок 7 и сравнение со всеми сделками
      портала под фильтром не считаются.
    </p>
  </div>
</template>
