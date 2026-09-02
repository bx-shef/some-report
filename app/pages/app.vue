<script setup lang="ts">
/**
 * Главный экран — сам отчёт. Открывается порталом из пункта CRM-аналитики (`CRM_ANALYTICS_MENU`).
 */
const { dataset, report, conversionBase, isDemo } = useReportData()
const b24 = useB24()

useHead({ title: 'Отчёт' })

onMounted(async () => {
  await b24.init()
  // Портал не знает высоту нашего содержимого: без этого фрейм остаётся высотой в один экран
  // и таблицы уезжают под собственный скролл внутри страницы портала.
  await b24.fitWindow()
})

// Смена базы конверсий меняет высоту не блоков, а подписей — но таблицы под ними всё равно
// сдвигаются, поэтому пересогласуем высоту фрейма.
watch(conversionBase, async () => {
  await nextTick()
  await b24.fitWindow()
})
</script>

<template>
  <InPortalGate>
    <main class="mx-auto max-w-[90rem] space-y-4 p-4 lg:p-6">
      <ReportToolbar
        v-model:conversion-base="conversionBase"
        :period="dataset.period"
        :is-demo="isDemo"
      />

      <B24Alert
        v-if="isDemo"
        color="air-primary-warning"
        title="Показаны демонстрационные данные"
        description="Отчёт пока считает по набору с согласованного макета, а не по вашему порталу. Живая выборка подключается следующим шагом — формулы и разметка уже те же самые."
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
