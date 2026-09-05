<script setup lang="ts">
import type { ManagerCellRef, ManagerFilters } from '~/types/managers'
import { DEFAULT_MANAGER_FILTERS } from '~/composables/useManagerReport'
import { managerDealFilter } from '~/utils/managerQuery'
import { OFFICE_UNSET, SCOPE_LABELS } from '~/utils/managerLoad'
import { formatCount, formatPercent } from '~/utils/format'

/**
 * Отчёт «Сделки по менеджерам»: сколько сделок у каждого менеджера в каждом офисе и на какой
 * стадии. Направление, охват и период — фильтром; за каждым числом открывается список сделок.
 *
 * Идея взята из прежнего отчёта «Незакрытые заказы» на самом портале (офис → менеджер → стадия),
 * но считает он СДЕЛКИ и живёт снаружи, в приложении: доступа к базе портала у нас нет, а
 * счётчики REST на боевых объёмах отвечают за секунды (`docs/PORTAL.md`).
 */
const {
  report, categories, stages, dictionaries, filters: appliedFilters,
  pending, step, error, truncatedManagers, truncatedOffices,
  stagesDeferred, stagesEstimateSeconds, startStages, isDemo, load
} = useManagerReport()

const b24 = useB24()
const today = new Date()

/** Выбранный отбор. Применённый живёт в композабле — подпись строится по нему. */
const filters = ref<ManagerFilters>({ ...DEFAULT_MANAGER_FILTERS })

const {
  open: drillOpen, request: drillRequest, rows: drillRows, pending: drillPending,
  error: drillError, done: drillDone, show: showDrill, loadMore: drillMore, openRow: openDrillRow, cellRequest
} = useManagerDrilldown({ filters: appliedFilters, dictionaries, isDemo })

useHead({ title: 'Сделки по менеджерам' })

/**
 * До первой выборки на экране НИЧЕГО, кроме «Загрузка».
 *
 * ⚠ Показывать демо-набор, пока идут живые данные, нельзя: руководитель читает числа раньше
 * плашек и десять секунд видит чужие. Это решение владельца от 2026-09-04 по отчёту о лидах, и
 * здесь оно ровно то же.
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

/** Список за числом матрицы — тем же условием, что дало число. */
function openCell(cell: ManagerCellRef): void {
  showDrill(cellRequest(cell.title, managerDealFilter(appliedFilters.value), cell, cell.total))
}

/** Сколько сделок не попало ни в одну строку таблицы — про это нельзя молчать. */
const outsideNote = computed(() => {
  const notes: string[] = []
  if (report.value.unlisted > 0) {
    notes.push(`Сделок вне строк таблицы: ${formatCount(report.value.unlisted)} — у них не назначен ответственный или он не нашёлся среди ответственных этого отбора.`)
  }
  if (report.value.otherStages > 0) {
    notes.push(`Сделок на стадиях, которых нет в справочнике направления: ${formatCount(report.value.otherStages)} — стадию удалили из воронки, а сделки на ней остались.`)
  }
  // Причины усечения разные, и подсказка человеку тоже разная: общий флаг назвал бы неверную.
  if (truncatedManagers.value) {
    notes.push('Сотрудников в этом направлении больше, чем отчёт перечисляет за один проход: часть сделок ушла в строку «вне таблицы». Сузьте отбор — направлением, охватом или периодом.')
  }
  if (truncatedOffices.value) {
    notes.push('«Моих компаний» у сделок больше, чем отчёт перечисляет за один проход: часть офисов в таблицу не попала, их сделки видны только в общем итоге.')
  }
  if (report.value.hiddenStages > 0) {
    notes.push(`Пустых стадий скрыто: ${report.value.hiddenStages} — в них нет ни одной сделки под этим отбором.`)
  }
  return notes
})

/**
 * Доля сделок без «моей компании».
 *
 * ⚠ На боевом портале заказчика это 92 % (замер `docs/PORTAL.md`), и молчать об этом нельзя:
 * руководитель, увидев почти всё в одной строке, решит, что сломан ОТЧЁТ, а не что поле в CRM
 * никто не заполняет. Это разные выводы, и второй — правда.
 */
const unsetOfficeShare = computed(() => {
  const total = report.value.total
  const unset = report.value.offices.find(office => office.officeId === OFFICE_UNSET)?.total ?? 0
  return total > 0 ? unset / total : 0
})

const officeFieldNote = computed(() => {
  if (pending.value || unsetOfficeShare.value < 0.5) return undefined
  return `У ${formatPercent(unsetOfficeShare.value)} сделок этого отбора поле «Моя компания» не заполнено, поэтому разрез по офисам показывает только оставшуюся часть. Это свойство данных CRM, а не отчёта: чтобы разрез заработал, поле нужно заполнять — правилом в карточке сделки, роботом на создание или при импорте.`
})

/** Сколько ждать стадии, если считать их по кнопке. */
const stagesEstimateText = computed(() => {
  const seconds = stagesEstimateSeconds.value
  return seconds >= 90 ? `около ${Math.round(seconds / 60)} мин` : `около ${Math.max(5, Math.round(seconds / 5) * 5)} с`
})

/** Пусто — не поломка: под отбором сделок может не быть, и это нужно сказать словами. */
const emptyNote = computed(() => {
  // ⚠ При ошибке портала молчим: «сделок нет» — это утверждение о данных, а мы их не прочитали.
  // Рядом стоит плашка ошибки, и два разных объяснения одной пустоты сбивают с толку.
  if (pending.value || error.value || report.value.total > 0) return undefined
  const applied = appliedFilters.value
  const name = categories.value.find(category => category.id === applied.categoryId)?.name ?? `направление #${applied.categoryId}`
  const scope = SCOPE_LABELS[applied.scope].toLowerCase()
  return `Под этим отбором сделок нет: «${name}», ${scope}${applied.period ? ', выбранный период' : ', за всё время'}. Выберите другое направление, охват или период.`
})

/**
 * Портал не знает высоту нашего содержимого: без этого фрейм остаётся высотой в один экран, и
 * таблица уезжает под собственный скролл внутри страницы портала.
 */
async function fit() {
  await nextTick()
  await b24.fitWindow()
}
</script>

<template>
  <InPortalGate @ready="fit">
    <main class="mx-auto max-w-[90rem] space-y-4 p-4 lg:p-6">
      <ReportNav />

      <ManagerToolbar
        v-model="filters"
        :categories="categories"
        :stages="stages"
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
          Считаем сделки портала по офисам, менеджерам и стадиям. На боевом портале это около
          шестнадцати секунд.
        </p>
      </B24Card>

      <template v-else>
        <p
          v-if="pending"
          class="text-sm opacity-70"
        >
          {{ step ?? 'Считаем…' }} На боевом портале это около шестнадцати секунд.
        </p>

        <B24Alert
          v-if="isDemo"
          color="air-primary-warning"
          title="Это НЕ данные вашего портала"
          description="На экране демонстрационный набор: вымышленные офисы, сотрудники и сделки. Живые данные отчёт берёт, только когда открыт внутри Битрикс24 — из раздела CRM-аналитики или по плитке приложения."
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
          title="Под этим отбором сделок нет"
          :description="emptyNote"
        />

        <div
          v-if="report.total > 0"
          class="grid grid-cols-2 gap-2 md:grid-cols-4"
        >
          <B24Card>
            <StatTile
              label="Сделок"
              :value="formatCount(report.total)"
              :hint="SCOPE_LABELS[appliedFilters.scope]"
            />
          </B24Card>
          <B24Card>
            <StatTile
              label="Менеджеров"
              :value="formatCount(report.managers)"
              hint="с хотя бы одной сделкой"
            />
          </B24Card>
          <B24Card>
            <StatTile
              label="Офисов"
              :value="formatCount(report.officeCount)"
              hint="«моя компания» сделки"
            />
          </B24Card>
          <B24Card>
            <StatTile
              label="Стадий в таблице"
              :value="formatCount(report.stages.length)"
              :hint="`из ${formatCount(stages.length)} в направлении`"
            />
          </B24Card>
        </div>

        <B24Alert
          v-if="officeFieldNote"
          color="air-primary-warning"
          title="Поле «Моя компания» у сделок почти не заполнено"
          :description="officeFieldNote"
        />

        <B24Alert
          v-if="outsideNote.length"
          color="air-primary-warning"
          title="Что нужно знать про эти числа"
          :description="outsideNote.join(' ')"
        />

        <!-- Стадий слишком много для одного прохода: считаем по кнопке, а не молча заставляем ждать. -->
        <B24Card v-if="stagesDeferred">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-sm">
              Разбивка по стадиям не посчитана: под этим отбором это
              {{ stagesEstimateText }} ожидания. В таблице пока итоги по менеджерам.
            </p>
            <B24Button
              size="sm"
              color="air-primary"
              :label="pending ? 'Считаем…' : 'Посчитать по стадиям'"
              :disabled="pending"
              @click="startStages"
            />
          </div>
        </B24Card>

        <ManagerMatrix
          :report="report"
          @drill="openCell"
        />

        <ReportDrilldown
          v-model:open="drillOpen"
          :request="drillRequest"
          :rows="drillRows"
          :pending="drillPending"
          :error="drillError"
          :done="drillDone"
          :is-demo="isDemo"
          @more="drillMore"
          @open-row="openDrillRow"
        />
      </template>
    </main>
  </InPortalGate>
</template>
