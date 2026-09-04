<script setup lang="ts">
import { CalendarDate, getLocalTimeZone, today } from '@internationalized/date'
import CalendarIcon from '@bitrix24/b24icons-vue/outline/CalendarIcon'
import { fromIsoDate, toIsoDate } from '~/utils/period'

/**
 * Выбор периода отчёта — ОДНО поле-диапазон, а не два поля «от» и «до».
 *
 * ⚠ Одно поле здесь не косметика. Два отдельных календаря показывают два одинаковых месяца рядом,
 * и по ним нельзя увидеть ПЕРИОД: человек выбирает начало, теряет его из виду, выбирает конец в
 * соседнем календаре и получает перевёрнутый период, о котором узнаёт из предупреждения внизу.
 * Диапазон в одном календаре подсвечивает выбранное между границами и перевёрнутым быть не может
 * по построению — проверка «начало позже конца» остаётся только для значений, пришедших снаружи.
 *
 * ⚠ Наружу отдаём СТРОКИ `ГГГГ-ММ-ДД`, внутрь прячем `@internationalized/date`. Иначе тип
 * `CalendarDate` протёк бы в панель, в композабл и в запрос к порталу — а там нужен обычный
 * текст, который уходит в фильтр REST как есть.
 *
 * Подход подсмотрен в `bx-shef/client-bank-alfa-by` (`DayRangeField.vue`), включая пару граблей:
 * `locale="ru"` задаётся полю И календарю по отдельности, иначе месяцы английские и неделя
 * начинается с воскресенья.
 */
const from = defineModel<string>('from', { default: '' })
const to = defineModel<string>('to', { default: '' })

const inputDate = useTemplateRef<{ inputsRef?: { $el?: HTMLElement }[] }>('inputDate')
const calendarOpen = ref(false)

function toCalendar(iso: string): CalendarDate | undefined {
  const date = fromIsoDate(iso)
  return date ? new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate()) : undefined
}

function toIso(value: CalendarDate | undefined): string {
  return value ? toIsoDate(new Date(value.year, value.month - 1, value.day)) : ''
}

const value = computed({
  // ⚠ Именно `undefined`, а не `null`: незаполненную границу `DateRange` описывает отсутствием
  // значения, и `null` тип не принимает.
  get: () => ({ start: toCalendar(from.value), end: toCalendar(to.value) }),
  set: (range) => {
    from.value = toIso(range?.start)
    to.value = toIso(range?.end)
  }
})

/**
 * Выбор в календаре: записать и закрыть окно ПОСЛЕ ВТОРОЙ границы.
 *
 * ⚠ Не после первой: у периода два клика, и закрытие по первому не дало бы выбрать конец.
 */
function pickRange(range: { start?: unknown, end?: unknown } | null): void {
  const start = range?.start as CalendarDate | undefined
  const end = range?.end as CalendarDate | undefined
  value.value = { start, end }
  if (start && end) calendarOpen.value = false
}

/** Будущее выбрать нельзя: лидов, созданных завтра, не бывает. */
const maxValue = computed(() => today(getLocalTimeZone()))
</script>

<template>
  <B24InputDate
    ref="inputDate"
    v-model="value"
    range
    locale="ru"
    size="sm"
    :max-value="maxValue"
    data-testid="period-input"
  >
    <template #trailing>
      <B24Popover
        v-model:open="calendarOpen"
        :reference="inputDate?.inputsRef?.[0]?.$el"
      >
        <B24Button
          color="air-tertiary-no-accent"
          size="sm"
          :icon="CalendarIcon"
          aria-label="Выбрать период в календаре"
          class="px-0"
          data-testid="period-calendar-open"
        />

        <template #content>
          <B24Calendar
            :model-value="value"
            class="p-2"
            range
            locale="ru"
            :number-of-months="2"
            :max-value="maxValue"
            data-testid="period-calendar"
            @update:model-value="pickRange"
          />
        </template>
      </B24Popover>
    </template>
  </B24InputDate>
</template>
