<script setup lang="ts">
import type { ReportPeriod } from '~/types/report'
import { formatDate } from '~/utils/format'
import { currentMonthPeriod } from '~/utils/b24Query'

/**
 * Главный экран — сам отчёт. Открывается порталом из пункта CRM-аналитики (`CRM_ANALYTICS_MENU`).
 */
const { dataset, report, conversionBase, isDemo, pending, error, warnings, latestLeadDate, load } = useReportData()

/**
 * «Сегодня» фиксируется ОДИН раз на открытие отчёта.
 *
 * ⚠ Не `new Date()` в каждом вычислении: пересчёт в полночь молча сдвинул бы подсветку интервала
 * и границы «последних 7 дней» под руками у человека.
 */
const today = new Date()

/** Выбранный период. Умолчание — текущий месяц: отчёт открывают посмотреть, как идут дела сейчас. */
const period = ref<ReportPeriod>(dataset.value.period)
const b24 = useB24()

useHead({ title: 'Отчёт' })

onMounted(async () => {
  await b24.init()
  // ⚠ Период подменяем на текущий месяц ТОЛЬКО внутри портала. Снаружи на экране остаётся
  // демонстрационный набор со своим периодом, и подпись обязана совпадать с данными: шапка
  // «сентябрь» над августовскими числами — это ровно то враньё, из-за которого заказчик уже
  // однажды принял чужие цифры за свои.
  if (b24.isInit()) period.value = currentMonthPeriod(today)
  // Внутри портала берём живые лиды и сделки. Снаружи `load()` тихо ничего не делает.
  await load(period.value)
  await fit()
})

// Смена периода — новая выборка. Гонку ответов сторожит сам композабл.
watch(period, async (next) => {
  await load(next)
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
    notes.push(`Сделок без связи с лидом: ${w.dealsWithoutLead}. Пока связь не настроена, воронка «лид → сделка» не собирается.`)
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
const emptyPeriodNote = computed(() => {
  if (isDemo.value || pending.value || report.value.summary.totalLeads > 0) return undefined
  if (!latestLeadDate.value) {
    return 'В портале не нашлось ни одного лида — ни за этот период, ни раньше. Проверьте, что у приложения есть доступ к CRM.'
  }
  return `За этот период в портале нет ни одного лида. Последний лид создан ${formatDate(latestLeadDate.value)} — отчёт пока считает только текущий месяц, редактируемый период делается отдельно.`
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

// Смена базы конверсий меняет не блоки, а подписи — но таблицы под ними всё равно сдвигаются.
watch(conversionBase, fit)
</script>

<template>
  <InPortalGate @ready="fit">
    <main class="mx-auto max-w-[90rem] space-y-4 p-4 lg:p-6">
      <ReportToolbar
        v-model:conversion-base="conversionBase"
        v-model:period="period"
        :today="today"
        :is-demo="isDemo"
      />

      <p
        v-if="pending"
        class="text-sm opacity-70"
      >
        Читаем лиды и сделки портала…
      </p>

      <!-- ⚠ Демо-плашку заказчик однажды не заметил и принял числа макета за свои. Поэтому
           формулировка теперь не «данные демонстрационные», а «это НЕ ваш портал». -->
      <B24Alert
        v-if="isDemo"
        color="air-primary-warning"
        title="Это НЕ данные вашего портала"
        description="На экране демонстрационный набор с согласованного макета: 1 250 лидов, 250 брака, 485 000 выручки. Ваши лиды здесь не считаются. Отчёт берёт живые данные, только когда открыт внутри Битрикс24 — из раздела CRM-аналитики или по плитке приложения."
      />

      <B24Alert
        v-if="error"
        color="air-primary-alert"
        title="Не удалось прочитать данные портала"
        :description="`${error} Показан демонстрационный набор, а не ваши данные.`"
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

      <ReportProcessing
        :report="report"
        :dictionaries="dataset.dictionaries"
      />
    </main>
  </InPortalGate>
</template>
