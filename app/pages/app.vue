<script setup lang="ts">
import type { ReportFilters, ReportPeriod } from '~/types/report'
import { hasFilters, needsLeadIds } from '~/utils/filters'
import { formatDate } from '~/utils/format'
import { periodLengthDays, resolvePreset, samePeriod } from '~/utils/period'
import { PROCESSING_MINUTES_PER_MONTH, UNLINKED_MINUTES_PER_MONTH } from '~/composables/useReportData'

/**
 * Главный экран — сам отчёт. Открывается порталом из пункта CRM-аналитики (`CRM_ANALYTICS_MENU`).
 */
const {
  dataset, report, isDemo, pending, error, warnings, latestLeadDate, load, filters: appliedFilters,
  unlinkedPending, unlinkedError, unlinkedDeferred, startUnlinked,
  processingPending, processingError, processingDeferred, processingTimed, startProcessing
} = useReportData()

/**
 * «Сегодня» фиксируется ОДИН раз на открытие отчёта.
 *
 * ⚠ Не `new Date()` в каждом вычислении: пересчёт в полночь молча сдвинул бы подсветку интервала
 * и границы «последних 7 дней» под руками у человека.
 */
const today = new Date()

/** Выбранный период. Умолчание — текущий месяц: отчёт открывают посмотреть, как идут дела сейчас. */
const period = ref<ReportPeriod>(dataset.value.period)
/** Выбранные фильтры (ТЗ от 2026-09-04). Панель появляется после первой выборки — см. `booting`. */
const filters = ref<ReportFilters>({})
const b24 = useB24()

useHead({ title: 'Отчёт' })

/**
 * До первой выборки на экране НИЧЕГО, кроме «Загрузка».
 *
 * ⚠ Раньше до прихода данных портала показывался демо-набор: руководитель открывал отчёт и
 * секунд пятнадцать видел «1 250 лидов», которых у него нет. Плашка «это НЕ ваш портал» не
 * спасала — числа читают раньше плашек. Решение владельца от 2026-09-04: просто «Загрузка».
 */
const booting = ref(true)

onMounted(async () => {
  await b24.init()
  // ⚠ Период подменяем на текущий месяц ТОЛЬКО внутри портала. Снаружи на экране остаётся
  // демонстрационный набор со своим периодом, и подпись обязана совпадать с данными: шапка
  // «сентябрь» над августовскими числами — это ровно то враньё, из-за которого заказчик уже
  // однажды принял чужие цифры за свои.
  if (b24.isInit()) period.value = resolvePreset('this-month', today)!
  // Внутри портала берём живые лиды и сделки. Снаружи `load()` тихо ничего не делает.
  const requested = period.value
  await load(requested, filters.value)
  booting.value = false
  // ⚠ Пока шла первая выборка, кнопки периода были живые, а наблюдатель ниже молчал. Если
  // человек успел нажать «Прошлый месяц», выбранный период уже не тот, что запрошен, — иначе
  // подсветка показывала бы август над сентябрьскими числами, и второй клик ничего бы не менял.
  // Сравниваем с ЗАПРОШЕННЫМ периодом, а не с `dataset.period`: при ошибке портала набор
  // остаётся демонстрационным со своим периодом, и сравнение с ним слало бы второй запрос
  // в упавший портал без участия человека.
  if (b24.isInit() && !samePeriod(period.value, requested)) await load(period.value, filters.value)
  await fit()
})

/**
 * Сколько ждать справку блока 7, в минутах: ≈ 5 500 строк на месяц по замеру боевого портала
 * (`docs/PORTAL.md`), то есть около минуты на каждые 30 дней. Год — минут двенадцать, и
 * обещать «примерно минуту» на нём значило бы, что человек решит, будто отчёт завис.
 */
const unlinkedEstimateMinutes = computed(() => Math.max(1, Math.round(periodLengthDays(dataset.value.period) / 30 * UNLINKED_MINUTES_PER_MONTH)))
/** История стадий вдвое объёмнее справки блока 7: ≈ 9 700 записей в месяц, около двух минут. */
const processingEstimateMinutes = computed(() => Math.max(1, Math.round(periodLengthDays(dataset.value.period) / 30 * PROCESSING_MINUTES_PER_MONTH)))

// Фоновые выборки приходят на минуты позже отчёта и меняют высоту страницы — портал должен
// узнать об этом, иначе таблицы уедут под нижний край фрейма.
watch([unlinkedPending, unlinkedDeferred, processingPending, processingDeferred], fit)

/**
 * Первая загрузка идёт из `onMounted`, а НЕ из наблюдателя за периодом.
 *
 * ⚠ Наблюдатель регистрируется в setup, и присвоение `period.value` в `onMounted` запускало бы
 * его тоже — две выборки одного периода на каждое открытие. Гонку данных `seq` в композабле
 * снял бы, но портал получал бы вдвое больше запросов, а именно запросы здесь и дороги.
 * Смена периода человеком после загрузки — новая выборка; гонку ответов сторожит композабл.
 */
watch([period, filters], async () => {
  if (booting.value) return
  await load(period.value, filters.value)
  await fit()
})

/**
 * Оговорки к качеству данных портала.
 *
 * ⚠ Молчать о них нельзя. «Сделок, не связанных с лидом: 340» — это объяснение, почему воронка
 * показывает ноль квалифицированных; без него руководитель читает ноль как факт о работе отдела
 * продаж. Каждая строка здесь — не про наш код, а про то, что нужно поправить в CRM.
 */
const dataNotes = computed(() => {
  const w = warnings.value
  if (!w) return []
  const notes: string[] = []
  if (w.dealsWithoutLead > 0) {
    notes.push(`Сделок без связи с лидом среди выбранных строками: ${w.dealsWithoutLead} — в разрез источников лидов они не попадают.`)
  }
  if (w.dealsWithMissingLead > 0) {
    notes.push(`Сделок со ссылкой на лид вне периода: ${w.dealsWithMissingLead}.`)
  }
  if (w.wonStageWithoutDeal > 0) {
    notes.push(`Лидов на стадии «успех», у которых нет сделки: ${w.wonStageWithoutDeal}.`)
  }
  if (w.unconvertedDeals > 0) {
    notes.push(`Сделок в валюте без курса — суммы взяты как есть: ${w.unconvertedDeals}.`)
  }
  if (w.duplicateIds > 0) {
    notes.push(`Повторов по идентификатору отброшено: ${w.duplicateIds}.`)
  }
  if (w.wonWithoutAmount > 0) {
    notes.push(`Успешных сделок из лидов с нулевой суммой: ${w.wonWithoutAmount}. Выручка по лидам считается по сумме сделки, а она в CRM не заполнена — деньги, судя по всему, оформляются на других сделках.`)
  }
  if (w.mergedLossReasons > 0) {
    notes.push(`Одинаковые причины проигрыша из разных направлений сведены в одну строку: стадий свёрнуто ${w.mergedLossReasons}. В CRM они по-прежнему разные.`)
  }
  if (w.firstResponseNotFetched) {
    notes.push('Время первого ответа не выбиралось — блок «Обработка лидов» считать не по чему.')
  }
  return notes
})

/**
 * Пустой период — не поломка, но и не «просто нули».
 *
 * ⚠ Отчёт, открытый 3-го числа, показывает нули за текущий месяц совершенно законно. Человек же
 * читает нули как «приложение сломалось» — и он прав в том, что экран ему ничего не объяснил.
 * Поэтому здесь либо «в портале вообще нет лидов», либо «в этом периоде нет, последний был тогда-то».
 */
/**
 * Фильтр по причине проигрыша оставляет ТОЛЬКО проигранные сделки этой причины — успешных среди
 * них нет по определению, и сводка, воронка, источники честно показывают ноль продаж при полных
 * лидах. Без подписи это читается как «в этом месяце ничего не продали» (ревью PR фильтров).
 */
const lossReasonNote = computed(() =>
  appliedFilters.value.lossReasonKey && !pending.value
    ? 'Выбрана причина проигрыша сделки: в сводке, воронке и источниках успешных сделок и выручки нет по построению — фильтр оставляет только проигранные сделки этой причины, лиды и квалифицированные при этом полные. Смотрите блок 4 «Разбивка причин проигрыша сделок».'
    : undefined
)

const emptyPeriodNote = computed(() => {
  if (pending.value || report.value.summary.totalLeads > 0) return undefined
  // Под фильтром пустота — свойство фильтра, а не портала: подсказка про последний лид врала бы.
  if (hasFilters(appliedFilters.value)) {
    return 'Под выбранными фильтрами за этот период лидов нет. Снимите часть фильтров или выберите другой период.'
  }
  if (isDemo.value) return undefined
  if (!latestLeadDate.value) {
    return 'В портале не нашлось ни одного лида — ни за этот период, ни раньше. Проверьте, что у приложения есть доступ к CRM.'
  }
  return `За этот период в портале нет ни одного лида. Последний лид создан ${formatDate(latestLeadDate.value)} — выберите период, в который он попадает.`
})

/**
 * Портал не знает высоту нашего содержимого: без этого фрейм остаётся высотой в один экран, и
 * таблицы уезжают под собственный скролл внутри страницы портала.
 *
 * ⚠ Мерим по событию `ready` гейта, а не в своём `onMounted`. Отчёт живёт в слоте `InPortalGate` и
 * появляется в DOM только после его проверки — замер в `onMounted` попадал на заглушку
 * «Проверяем подключение…» и просил у портала высоту в одну строку.
 */
async function fit() {
  await nextTick()
  await b24.fitWindow()
}
</script>

<template>
  <InPortalGate @ready="fit">
    <main class="mx-auto max-w-[90rem] space-y-4 p-4 lg:p-6">
      <!-- Пока идёт первая выборка, на панели ни значка «Демо», ни периода демо-набора:
           «Загрузка» ниже обещает, что чужих чисел на экране нет, — и подпись тоже. -->
      <ReportToolbar
        v-model:period="period"
        :applied-period="booting ? undefined : dataset.period"
        :today="today"
        :is-demo="!booting && isDemo"
      />

      <B24Card v-if="booting">
        <p class="py-8 text-center text-lg font-semibold">
          Загрузка…
        </p>
        <p class="pb-6 text-center text-sm opacity-70">
          Читаем лиды и сделки портала. Месяц занимает около 15 секунд, год — до минуты.
        </p>
      </B24Card>

      <template v-else>
        <!-- Фильтры действуют на всё, кроме блока 7, — и он сам об этом говорит. -->
        <ReportFilters
          v-model="filters"
          :dictionaries="dataset.dictionaries"
          :disabled="pending"
        />

        <p
          v-if="pending"
          class="text-sm opacity-70"
        >
          Читаем лиды и сделки портала… Месяц занимает около 15 секунд, год — до минуты.
          <template v-if="needsLeadIds(filters)">
            Под фильтром по менеджеру или стадии дольше: сначала лиды под фильтром, потом их сделки.
          </template>
        </p>

        <!-- ⚠ Демо-плашку заказчик однажды не заметил и принял числа макета за свои. Поэтому
             формулировка теперь не «данные демонстрационные», а «это НЕ ваш портал». -->
        <B24Alert
          v-if="isDemo"
          color="air-primary-warning"
          title="Это НЕ данные вашего портала"
          description="На экране демонстрационный набор с согласованного макета: 1 250 лидов, 250 брака, 485 000 выручки. Ваши лиды здесь не считаются. Отчёт берёт живые данные, только когда открыт внутри Битрикс24 — из раздела CRM-аналитики или по плитке приложения."
        />

        <!-- ⚠ После удачной первой выборки неудачная вторая оставляет на экране ПРЕЖНИЕ данные
             портала, а не демо-набор: подпись обязана говорить, что именно осталось. -->
        <B24Alert
          v-if="error"
          color="air-primary-alert"
          title="Не удалось прочитать данные портала"
          :description="`${error} ${isDemo
            ? 'Показан демонстрационный набор, а не ваши данные.'
            : `На экране остались данные предыдущей выборки за ${formatDate(dataset.period.from)} — ${formatDate(dataset.period.to)}.`}`"
        />

        <B24Alert
          v-if="lossReasonNote"
          color="air-primary-warning"
          title="Успешных сделок под этим фильтром не бывает"
          :description="lossReasonNote"
        />

        <B24Alert
          v-if="emptyPeriodNote"
          color="air-primary-warning"
          title="За этот период данных нет"
          :description="emptyPeriodNote"
        />

        <!-- Оговорки к данным САМОГО портала: не ошибки отчёта, а то, что стоит поправить в CRM. -->
        <B24Alert
          v-if="dataNotes.length"
          color="air-primary-warning"
          title="Что нужно знать про эти числа"
          :description="dataNotes.join(' ')"
        />

        <ReportSummary
          :report="report"
          :currency-id="dataset.currencyId"
        />

        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1.2fr)]">
          <ReportFunnel
            :report="report"
            :currency-id="dataset.currencyId"
          />
          <ReportJunk
            :report="report"
            :dictionaries="dataset.dictionaries"
          />
          <ReportLosses
            :report="report"
            :dictionaries="dataset.dictionaries"
            :currency-id="dataset.currencyId"
          />
        </div>

        <ReportSources
          :report="report"
          :dictionaries="dataset.dictionaries"
          :currency-id="dataset.currencyId"
        />

        <ReportTopSources
          :report="report"
          :dictionaries="dataset.dictionaries"
          :currency-id="dataset.currencyId"
        />

        <ReportProcessing
          :report="report"
          :dictionaries="dataset.dictionaries"
          :pending="processingPending"
          :deferred="processingDeferred"
          :timed="isDemo ? undefined : processingTimed"
          :estimate-minutes="processingEstimateMinutes"
          :error="processingError"
          @start="startProcessing"
        />

        <!-- Блок-справка есть только у портала: на демо такого множества нет. Пока фоновая
             выборка идёт, блок сам говорит, что считает. -->
        <ReportUnlinkedDeals
          v-if="!isDemo"
          :unlinked="dataset.unlinkedDeals"
          :pending="unlinkedPending"
          :deferred="unlinkedDeferred"
          :estimate-minutes="unlinkedEstimateMinutes"
          :error="unlinkedError"
          :dictionaries="dataset.dictionaries"
          :currency-id="dataset.currencyId"
          :filtered="hasFilters(appliedFilters)"
          @start="startUnlinked"
        />
      </template>
    </main>
  </InPortalGate>
</template>
