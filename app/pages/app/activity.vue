<script setup lang="ts">
import type { ActivityFilters } from '~/types/activity'
import { defaultActivityFilters } from '~/composables/useActivityReport'
import { formatCount } from '~/utils/format'

/**
 * Отчёт «Активность пользователей»: сколько каждый сотрудник за период звонил, сколько наговорил и
 * сколько сделал дел в CRM. Отдел, период и порог разговора — фильтром.
 *
 * Перенесён с прежнего компонента заказчика (`reports.useractivity`), и его правила СОХРАНЕНЫ:
 * считаются только состоявшиеся разговоры дольше порога. Но устроен он иначе в трёх вещах, и все
 * три — решения владельца от 2026-09-06: отдел не зашит в код, а выбирается фильтром; порог —
 * настройка, а не константа; таблица показывает всех сотрудников сразу, а не одного за раз.
 *
 * ⚠ Данные приходят ДВУМЯ этапами. Дела и лиды — счётчиками, за секунды; звонки — строками и
 * фоном, потому что сумму длительности портал не отдаёт агрегатом вовсе. Поэтому таблица
 * появляется без звонков, а их столбцы стоят с прочерками, пока не прочитаны: ноль там читался бы
 * как «не звонил».
 */
const b24 = useB24()
const today = new Date()

const {
  report, departments, filters: appliedFilters,
  pending, callsPending, callPagesRead, callsTruncated, step, error, callsError, isDemo, load
} = useActivityReport({ today })

/** Выбранный отбор. Применённый живёт в композабле — подпись строится по нему. */
const filters = ref<ActivityFilters>(defaultActivityFilters(today))

useHead({ title: 'Активность пользователей' })

/**
 * До первой выборки на экране НИЧЕГО, кроме «Загрузка».
 *
 * ⚠ Показывать демо-набор, пока идут живые данные, нельзя: руководитель читает числа раньше
 * плашек и секунды видит чужие. Решение владельца от 2026-09-04 по отчёту о лидах — здесь оно
 * ровно то же.
 */
const booting = ref(true)

onMounted(async () => {
  await b24.init()
  await load(filters.value)
  booting.value = false
  await fit()
})

// Смена отбора — новая выборка. Гонку ответов сторожит композабл. Глубокого слежения не нужно:
// панель всегда присваивает отбор ЦЕЛИКОМ, новым объектом.
watch(filters, async () => {
  if (booting.value) return
  await load(filters.value)
  await fit()
})

/** Подпись про фоновые звонки: сколько уже прочитано, чтобы ожидание не выглядело зависанием. */
const callsNote = computed(() => {
  if (!callsPending.value) return undefined
  const pages = callPagesRead.value
  return pages > 0
    ? `Читаем звонки: ${formatCount(pages * 50)} записей. На боевом портале месяц — около полутора минут.`
    : 'Читаем звонки. На боевом портале месяц — около полутора минут.'
})

/**
 * Пусто — не поломка: под отбором сотрудников может не быть, и это нужно сказать словами.
 *
 * ⚠ При ошибке портала молчим: «сотрудников нет» — это утверждение о данных, а мы их не прочитали.
 * Рядом стоит плашка ошибки, и два разных объяснения одной пустоты сбивают с толку.
 */
const emptyNote = computed(() => {
  if (pending.value || error.value || report.value.rows.length > 0) return undefined
  const applied = appliedFilters.value
  const department = applied.departmentId === undefined
    ? undefined
    : (departments.value.find(item => item.id === applied.departmentId)?.name ?? `отдел #${applied.departmentId}`)
  return department
    ? `В отделе «${department}» и его подотделах сотрудников не нашлось. Выберите другой отдел или «Все отделы».`
    : 'Сотрудников не нашлось. Возможно, у приложения нет права user_brief — тогда список сотрудников портал не отдаёт.'
})

/**
 * Портал не знает высоту нашего содержимого: без этого фрейм остаётся высотой в один экран, и
 * таблица уезжает под собственный скролл внутри страницы портала.
 */
async function fit() {
  await nextTick()
  await b24.fitWindow()
}

// ⚠ Высоту пересчитываем и когда доезжают звонки: таблица к этому моменту уже нарисована, но
// плашка «читаем звонки» исчезает, и фрейм остаётся выше содержимого на её высоту.
watch(callsPending, () => {
  void fit()
})
</script>

<template>
  <InPortalGate @ready="fit">
    <main class="mx-auto max-w-[90rem] space-y-3 p-2 sm:space-y-4 sm:p-4 lg:p-6">
      <ReportNav />

      <ActivityToolbar
        v-model="filters"
        :departments="departments"
        :applied-filters="booting ? undefined : appliedFilters"
        :is-demo="!booting && isDemo"
        :today="today"
        :disabled="pending"
      />

      <B24Card v-if="booting">
        <p class="py-8 text-center text-lg font-semibold">
          Загрузка…
        </p>
        <p class="pb-6 text-center text-sm opacity-70">
          Считаем дела и лиды сотрудников портала. На боевом портале это около шести секунд;
          звонки досчитываются фоном ещё около полутора минут.
        </p>
      </B24Card>

      <template v-else>
        <p
          v-if="pending"
          class="text-sm opacity-70"
        >
          {{ step ?? 'Считаем…' }} На боевом портале это около шести секунд.
        </p>

        <B24Alert
          v-if="isDemo"
          color="air-primary-warning"
          title="Это НЕ данные вашего портала"
          description="На экране демонстрационный набор: вымышленные сотрудники, звонки и дела. Живые данные отчёт берёт, только когда открыт внутри Битрикс24 — из раздела CRM-аналитики или по плитке приложения."
        />

        <B24Alert
          v-if="error"
          color="air-primary-alert"
          title="Не удалось прочитать данные портала"
          :description="error"
        />

        <B24Alert
          v-if="emptyNote"
          color="air-primary-warning"
          title="Под этим отбором сотрудников нет"
          :description="emptyNote"
        />

        <ActivitySummary
          :report="report"
          :calls-pending="callsPending"
        />

        <p
          v-if="callsNote"
          class="text-sm opacity-70"
          data-testid="calls-progress"
        >
          {{ callsNote }}
        </p>

        <!-- Звонки не дочитались: числа в их столбцах занижены, и молчать об этом нельзя. -->
        <B24Alert
          v-if="callsError"
          color="air-primary-warning"
          title="Звонки прочитаны не полностью"
          :description="`Дела и лиды посчитаны верно, а чтение звонков оборвалось: ${callsError}. В столбцах разговоров показано только то, что успело прийти.`"
        />

        <B24Alert
          v-if="callsTruncated"
          color="air-primary-warning"
          title="Звонков больше, чем отчёт читает за раз"
          description="Показаны не все разговоры периода: их слишком много для одного прохода. Выберите период короче — например, одну неделю."
        />

        <ActivityTable :report="report" />
      </template>
    </main>
  </InPortalGate>
</template>
