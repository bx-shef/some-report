<script setup lang="ts">
import type { ManagerCellRef, ManagerLoadCompany, ManagerLoadReport } from '~/types/managers'
import { companyFullLabel, UNLISTED_MANAGER_LABEL } from '~/utils/managerLoad'
import { formatCount } from '~/utils/format'

/**
 * Матрица «компания → менеджер → стадия»: по карточке на компанию, строка на менеджера, столбец на
 * стадию. Компонент только рисует: ни одной формулы здесь нет — всё посчитано ядром
 * (`app/utils/managerLoad.ts`), а условие списка за числом собирает страница.
 *
 * ⚠ Пустых столбцов нет: у направления заказчика 16 стадий, а «в работе» из них четыре.
 * Сколько скрыто — сказано подписью, чтобы сверка со справочником CRM не выглядела как потеря.
 *
 * ⚠ У матрицы ДВЕ раскладки. До `md` — карточка на менеджера: шестнадцать стадий в строку требуют
 * 640 пикселей, на телефоне их 390, и от таблицы был виден один столбец «Менеджер», а числа
 * уезжали за край. С `md` — таблица; она прокручивается ВНУТРИ карточки (`overflow-x-auto`), а не
 * растягивает страницу: во фрейме портала горизонтальный скролл всей страницы прячет часть отчёта
 * под край окна.
 *
 * ⚠ Числа рисует `ManagerCellNumber`, а не `DrillNumber`: тому нужен ГОТОВЫЙ запрос списка, а его
 * собирает страница (она знает отбор), поэтому компонент отдаёт наружу только «по какой клетке
 * нажали». Общий у них вид — класс `.drill-number`, чтобы кликабельные числа в обоих отчётах не
 * разъехались: часть подчёркнута, часть нет, и человек перестаёт понимать, где список есть.
 */
const props = defineProps<{
  report: ManagerLoadReport
}>()

const emit = defineEmits<{ drill: [ManagerCellRef] }>()

/**
 * Кому досталось больше всех в компании — по нему меряются полосы строк.
 *
 * Считается один раз на компанию, а не в каждой ячейке: строк в таблице десятки, и вызов из шаблона
 * повторялся бы на каждую перерисовку — так же, как это уже сделано в блоке источников.
 */
const peaks = computed(() => {
  const out: Record<number, number> = {}
  for (const company of props.report.companies) {
    out[company.companyId] = company.rows.reduce((max, row) => Math.max(max, row.total), 0)
  }
  return out
})

/** Клик по числу: заголовок списка повторяет то, по чему нажали. */
function cell(company: ManagerLoadCompany, parts: { managerId?: number, managerName?: string, stageId?: string, stageName?: string, total: number }): ManagerCellRef {
  // ⚠ В заголовке списка группа без компании зовётся «Без моей компании», а не «Не указана»:
  // в слайдере рядом нет заголовка про «мою компанию», и короткая подпись читалась бы как
  // «что не указана?». Тот же `companyFullLabel` берёт и диаграмма — иначе одно и то же число
  // открывало бы список с разными заголовками в зависимости от того, где по нему нажали.
  const title = [companyFullLabel(company.companyId, company.companyName), parts.managerName, parts.stageName].filter(Boolean).join(' · ')
  return {
    companyId: company.companyId,
    ...(parts.managerId === undefined ? {} : { managerId: parts.managerId }),
    ...(parts.stageId === undefined ? {} : { stageId: parts.stageId }),
    title: `Сделки: ${title}`,
    total: parts.total
  }
}

const hasOther = computed(() => props.report.otherStages > 0)

/**
 * Стадии с НЕнулевым числом по каждой строке — для карточек телефона.
 *
 * ⚠ Считается здесь, а не фильтром прямо в шаблоне: вызов из шаблона повторяется на каждую
 * перерисовку и для каждой строки — та же причина, по которой рядом посчитаны `peaks`.
 *
 * ⚠ Нули на телефоне не показываем вовсе: четыре прочерка из пяти — это шум, за которым не видно
 * единственного числа. В таблице прочерк нужен, там колонка обязана стоять на месте.
 */
const filledStages = computed(() => {
  const out: Record<string, typeof props.report.stages> = {}
  for (const company of props.report.companies) {
    for (const row of company.rows) {
      out[`${company.companyId}:${row.managerId}`] = props.report.stages.filter(stage => row.byStage[stage.id])
    }
  }
  return out
})
</script>

<template>
  <div class="space-y-4">
    <B24Card
      v-for="company in report.companies"
      :key="company.companyId"
    >
      <template #header>
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-base font-semibold">
            {{ company.companyName }}
          </h2>
          <!-- ⚠ Доли «от всех» здесь НЕТ, и это не забыли. Компания на экране одна (её выбирает
               фильтр), итог отбора равен итогу компании — доля всегда 100 %, в любой выборке.
               Число, которое не меняется никогда, не сообщает ничего и только занимает место. -->
          <p class="text-sm opacity-70">
            сделок: <span class="font-semibold">{{ formatCount(company.total) }}</span>
          </p>
        </div>
      </template>

      <!--
        ⚠ НА ТЕЛЕФОНЕ ТАБЛИЦЫ НЕТ, и это не «версия попроще». Шестнадцать стадий в строку требуют
        640 пикселей, а на экране их 390: таблица уезжала за край, и от неё было видно ровно один
        столбец «Менеджер» — числа, ради которых отчёт и открывают, оставались за кадром.
        Горизонтальная прокрутка внутри карточки этого не спасает: её там просто не находят.
        Поэтому до `md` те же данные идут карточкой на менеджера, а таблица начинается с `md`.
      -->
      <ul class="space-y-3 md:hidden">
        <li
          v-for="row in company.rows"
          :key="row.managerId"
          class="rounded-lg border border-[color:var(--chart-track)] p-3"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="min-w-0 truncate font-medium">
              <span :class="row.dismissed ? 'opacity-70' : ''">{{ row.managerName }}</span>
              <span
                v-if="row.dismissed"
                class="ml-1.5 rounded border border-[color:var(--chart-track)] px-1 py-0.5 align-middle text-[0.65rem] uppercase tracking-wide opacity-70"
                title="Сотрудник уволен: в портале он отмечен неактивным, но его сделки остаются в отчёте"
              >уволен</span>
            </span>
            <span class="shrink-0 font-semibold tabular-nums">
              <ManagerCellNumber
                :value="row.total"
                :title="`Открыть список: все сделки, ${row.managerName}`"
                @pick="emit('drill', cell(company, { managerId: row.managerId, managerName: row.managerName, total: row.total }))"
              />
            </span>
          </div>
          <MetricBar
            class="mt-2"
            :value="peaks[company.companyId] ? row.total / peaks[company.companyId]! : 0"
            :label="`${row.managerName}: ${formatCount(row.total)}`"
          />
          <!-- ⚠ Стадии с нулём здесь НЕ показываем: на узком экране четыре прочерка из пяти —
               это шум, за которым не видно единственного числа. В таблице прочерк нужен (колонка
               обязана быть на месте), а в списке пар — нет. -->
          <dl class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <div
              v-for="stage in filledStages[`${company.companyId}:${row.managerId}`] ?? []"
              :key="stage.id"
              class="flex items-baseline gap-1"
            >
              <dt class="opacity-60">
                {{ stage.name }}
              </dt>
              <dd class="tabular-nums">
                <ManagerCellNumber
                  :value="row.byStage[stage.id]"
                  :title="`Открыть список: ${row.managerName}, ${stage.name}`"
                  @pick="emit('drill', cell(company, { managerId: row.managerId, managerName: row.managerName, stageId: stage.id, stageName: stage.name, total: row.byStage[stage.id]! }))"
                />
              </dd>
            </div>
            <div
              v-if="hasOther && row.otherStages"
              class="flex items-baseline gap-1"
            >
              <dt class="opacity-60">
                Прочие стадии
              </dt>
              <dd class="tabular-nums opacity-70">
                {{ formatCount(row.otherStages) }}
              </dd>
            </div>
          </dl>
        </li>

        <!-- ⚠ У остатка на телефоне только ИТОГ, без разбивки по стадиям: за его числами списка
             всё равно нет («ответственный не из списка» фильтром REST не выразить), а разбивка
             заняла бы на узком экране больше места, чем все строки менеджеров. В таблице она
             остаётся. -->
        <li
          v-if="company.unlisted > 0"
          class="rounded-lg border border-dashed border-[color:var(--chart-track)] p-3 text-sm opacity-70"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span>{{ UNLISTED_MANAGER_LABEL }}</span>
            <span class="shrink-0 font-semibold tabular-nums">{{ formatCount(company.unlisted) }}</span>
          </div>
        </li>

        <li class="flex items-baseline justify-between gap-2 border-t border-[color:var(--chart-track)] pt-3 font-semibold">
          <span>Итого по компании</span>
          <span class="shrink-0 tabular-nums">
            <ManagerCellNumber
              :value="company.total"
              :title="`Открыть список: все сделки компании ${company.companyName}`"
              @pick="emit('drill', cell(company, { total: company.total }))"
            />
          </span>
        </li>
      </ul>

      <div class="hidden overflow-x-auto md:block">
        <table class="w-full min-w-[640px] text-sm">
          <thead>
            <tr class="border-b border-[color:var(--chart-track)] text-left text-xs opacity-60">
              <th class="py-2 pr-3 font-normal">
                Менеджер
              </th>
              <th
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right font-normal"
              >
                {{ stage.name }}
              </th>
              <th
                v-if="hasOther"
                class="py-2 pr-3 text-right font-normal"
              >
                Прочие стадии
              </th>
              <th class="py-2 text-right font-normal">
                Всего
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in company.rows"
              :key="row.managerId"
              class="border-b border-[color:var(--chart-track)]"
            >
              <td class="py-2 pr-3">
                <div class="min-w-[12rem]">
                  <span :class="row.dismissed ? 'opacity-70' : ''">{{ row.managerName }}</span>
                  <!-- ⚠ Уволенный помечается СЛОВОМ, а не только приглушённым цветом: цвет в этом
                       отчёте нигде не единственный носитель смысла, и «почему эта строка бледнее»
                       — вопрос, на который таблица обязана отвечать сама. Сделки его остаются в
                       отчёте: работа сделана, и из чисел компании она никуда не девается. -->
                  <span
                    v-if="row.dismissed"
                    class="ml-1.5 rounded border border-[color:var(--chart-track)] px-1 py-0.5 align-middle text-[0.65rem] uppercase tracking-wide opacity-70"
                    title="Сотрудник уволен: в портале он отмечен неактивным, но его сделки остаются в отчёте"
                  >уволен</span>
                  <MetricBar
                    class="mt-1"
                    :value="peaks[company.companyId] ? row.total / peaks[company.companyId]! : 0"
                    :label="`${row.managerName}: ${formatCount(row.total)}`"
                  />
                </div>
              </td>
              <td
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right tabular-nums"
              >
                <ManagerCellNumber
                  :value="row.byStage[stage.id]"
                  :title="`Открыть список: ${row.managerName}, ${stage.name}`"
                  dash
                  @pick="emit('drill', cell(company, { managerId: row.managerId, managerName: row.managerName, stageId: stage.id, stageName: stage.name, total: row.byStage[stage.id]! }))"
                />
              </td>
              <!-- Стадии вне справочника: число есть, а списка «тем же условием» нет — стадий мы
                   не знаем. Поэтому оно и не притворяется ссылкой. -->
              <td
                v-if="hasOther"
                class="py-2 pr-3 text-right tabular-nums opacity-70"
              >
                {{ row.otherStages ? formatCount(row.otherStages) : '—' }}
              </td>
              <td class="py-2 text-right font-semibold tabular-nums">
                <ManagerCellNumber
                  :value="row.total"
                  :title="`Открыть список: все сделки, ${row.managerName}`"
                  @pick="emit('drill', cell(company, { managerId: row.managerId, managerName: row.managerName, total: row.total }))"
                />
              </td>
            </tr>

            <!-- Сделки компании без строки: ответственный не назначен или не попал в перечисление. -->
            <tr
              v-if="company.unlisted > 0"
              class="border-b border-[color:var(--chart-track)]"
            >
              <td class="py-2 pr-3 opacity-70">
                {{ UNLISTED_MANAGER_LABEL }}
              </td>
              <!-- Стадия у этих сделок известна (итог колонки — счётчик портала), а
                   ответственный нет: числа есть, но списка «тем же условием» за ними не собрать —
                   «ответственный не из списка» фильтром REST не выражается. Поэтому не кнопки. -->
              <td
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right tabular-nums opacity-70"
              >
                {{ company.unlistedByStage[stage.id] ? formatCount(company.unlistedByStage[stage.id]!) : '—' }}
              </td>
              <td
                v-if="hasOther"
                class="py-2 pr-3 text-right opacity-30"
              >
                —
              </td>
              <td class="py-2 text-right tabular-nums opacity-70">
                {{ formatCount(company.unlisted) }}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="text-sm font-semibold">
              <td class="py-2 pr-3">
                Итого по компании
              </td>
              <td
                v-for="stage in report.stages"
                :key="stage.id"
                class="py-2 pr-3 text-right tabular-nums"
              >
                <ManagerCellNumber
                  :value="company.byStage[stage.id]"
                  :title="`Открыть список: ${company.companyName}, ${stage.name}`"
                  dash
                  @pick="emit('drill', cell(company, { stageId: stage.id, stageName: stage.name, total: company.byStage[stage.id]! }))"
                />
              </td>
              <td
                v-if="hasOther"
                class="py-2 pr-3 text-right tabular-nums"
              >
                {{ company.otherStages ? formatCount(company.otherStages) : '—' }}
              </td>
              <td class="py-2 text-right tabular-nums">
                <ManagerCellNumber
                  :value="company.total"
                  :title="`Открыть список: все сделки компании ${company.companyName}`"
                  @pick="emit('drill', cell(company, { total: company.total }))"
                />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p
        v-if="company.unlisted > 0"
        class="mt-3 text-xs opacity-60"
      >
        Строка «{{ UNLISTED_MANAGER_LABEL }}» — разница между итогом компании и суммой строк.
        Ответственный у сделки обязателен, поэтому причина здесь одна: сотрудник не попал в
        перечисление — например, его сделки появились уже после того, как отчёт перечислил
        менеджеров, или их больше, чем отчёт перечисляет за один проход. Стадии у этих сделок
        известны — итог каждой колонки портал считает отдельно, — а списка по клику за числами
        нет: «ответственный не из списка» фильтром не выразить.
      </p>
    </B24Card>
  </div>
</template>
