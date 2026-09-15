<script setup lang="ts">
import { formatDate } from '~/utils/format'
import { lockProgressPercent, secondsLabel, type PaymentLockStage } from '~/utils/paymentLock'

/**
 * Экран блокировки приложения при неподписанных актах.
 *
 * Два лица одного экрана: `soft` — напоминание с отсчётом, которое само пропускает дальше;
 * `hard` — отказ без отсчёта. Решает, какое показать, не этот компонент: сюда приезжает готовая
 * стадия (`usePaymentLock`), а здесь только рисование: даже доля полосы отсчёта считается снаружи,
 * чистой функцией под тестом.
 *
 * ⛔ Высота НЕ подгоняется под содержимое и НЕ задаётся в `vh`. Это не вкусовщина, а уже
 * оплаченный урок: `fitWindow` меряет содержимое и схлопывает фрейм, а `100vh` внутри фрейма
 * равен высоте этого схлопнутого фрейма — вместе они дают самоподдерживающееся сжатие, и
 * настоящий слайдер портала выглядит чужим окошком в треть экрана (CLAUDE.md, «Высоту фрейма
 * СЛАЙДЕРА под содержимое не подгоняем»). Поэтому здесь обычный поток и минимальная высота в
 * пикселях: экран одинаково выглядит и в высоком фрейме отчёта, и в невысоком фрейме плитки.
 */
const props = defineProps<{
  /** Что показываем: напоминание с отсчётом или отказ. */
  stage: Extract<PaymentLockStage, 'soft' | 'hard'>
  /** Сколько секунд осталось до снятия напоминания. */
  remaining: number
  /** День, с которого приложение перестанет открываться, — если он задан на сервере. */
  hardFrom?: string
}>()

const soft = computed(() => props.stage === 'soft')

/**
 * Доля полосы отсчёта.
 *
 * ⚠ Полоса нужна не для красоты: двадцать секунд без видимого движения читаются как «зависло», и
 * человек жмёт F5 — то есть начинает отсчёт заново и злится. Движущаяся полоса говорит «идёт», а
 * не «сломалось».
 *
 * ⚠ Сама доля считается в `app/utils/paymentLock.ts`, а не здесь. Сначала она была написана прямо
 * в этом файле — и это ровно тот дефект, который проект называет дефектом: формула в компоненте не
 * покрыта тестом. Заметила её проверка PR, а не я.
 */
const progress = computed(() => lockProgressPercent(props.remaining))
</script>

<template>
  <div
    class="flex min-h-[460px] items-center justify-center px-4 py-8"
    data-testid="payment-lock"
    :data-stage="stage"
  >
    <B24Card class="w-full max-w-3xl">
      <div class="flex flex-col items-center gap-6 md:flex-row md:items-center md:gap-8">
        <!--
          Экскаватор, который не работает. Рисунок свой, без библиотек: картинка здесь несёт
          смысл — «работа остановлена», — и объясняет его быстрее любого абзаца.
        -->
        <svg
          class="lock-scene w-full max-w-[320px] shrink-0 md:w-[320px]"
          viewBox="0 0 360 220"
          role="img"
          aria-label="Экскаватор стоит без работы: стрела опущена, ковш на земле"
        >
          <!-- Земля и нетронутая куча грунта: работа не начата. -->
          <ellipse
            cx="52"
            cy="192"
            rx="30"
            ry="7"
            fill="var(--lock-ground)"
          />
          <line
            x1="12"
            y1="198"
            x2="348"
            y2="198"
            stroke="var(--lock-ground)"
            stroke-width="4"
            stroke-linecap="round"
          />

          <g class="lock-body">
            <!-- Гусеница. Катки нарисованы, но не крутятся: машина стоит. -->
            <rect
              x="132"
              y="166"
              width="168"
              height="32"
              rx="16"
              fill="var(--lock-steel-dark)"
            />
            <rect
              x="144"
              y="175"
              width="144"
              height="14"
              rx="7"
              fill="var(--lock-steel)"
            />
            <circle
              cx="152"
              cy="182"
              r="9"
              fill="var(--lock-steel)"
            />
            <circle
              cx="280"
              cy="182"
              r="9"
              fill="var(--lock-steel)"
            />
            <circle
              v-for="x in [180, 208, 236, 264]"
              :key="x"
              :cx="x"
              cy="189"
              r="4"
              fill="var(--lock-steel-dark)"
            />

            <!-- Платформа, противовес, кабина. -->
            <rect
              x="146"
              y="134"
              width="146"
              height="34"
              rx="7"
              fill="var(--lock-machine)"
            />
            <rect
              x="270"
              y="128"
              width="30"
              height="40"
              rx="7"
              fill="var(--lock-machine-dark)"
            />
            <rect
              x="226"
              y="90"
              width="58"
              height="46"
              rx="8"
              fill="var(--lock-machine)"
            />
            <rect
              x="233"
              y="97"
              width="44"
              height="26"
              rx="4"
              fill="var(--lock-glass)"
            />

            <!-- Аварийный маячок: единственное, что на этой машине ещё работает. -->
            <rect
              x="252"
              y="84"
              width="8"
              height="7"
              rx="2"
              fill="var(--lock-steel-dark)"
            />
            <ellipse
              class="lock-beacon"
              cx="256"
              cy="81"
              rx="8"
              ry="7"
              fill="var(--lock-alarm)"
            />

            <!-- Выхлопная труба: из неё идёт дым, но машина не едет. -->
            <rect
              x="200"
              y="110"
              width="11"
              height="26"
              rx="3"
              fill="var(--lock-steel-dark)"
            />
            <rect
              x="196"
              y="105"
              width="19"
              height="7"
              rx="3"
              fill="var(--lock-steel)"
            />
          </g>

          <!-- Дым чихает клубами разной длительности: ровное дыхание читалось бы как «работает». -->
          <g fill="var(--lock-smoke)">
            <circle
              class="lock-puff lock-puff-1"
              cx="206"
              cy="98"
              r="6"
            />
            <circle
              class="lock-puff lock-puff-2"
              cx="206"
              cy="98"
              r="8"
            />
            <circle
              class="lock-puff lock-puff-3"
              cx="206"
              cy="98"
              r="5"
            />
          </g>

          <!--
            Стрела со стрелой-рукоятью и ковшом. Группа поворачивается вокруг пальца (150, 142):
            машина дёргается, пытаясь поднять стрелу, и роняет её обратно.
          -->
          <g class="lock-arm">
            <line
              x1="150"
              y1="142"
              x2="86"
              y2="92"
              stroke="var(--lock-machine-dark)"
              stroke-width="22"
              stroke-linecap="round"
            />
            <line
              x1="150"
              y1="142"
              x2="86"
              y2="92"
              stroke="var(--lock-machine)"
              stroke-width="14"
              stroke-linecap="round"
            />
            <line
              x1="162"
              y1="150"
              x2="112"
              y2="118"
              stroke="var(--lock-steel)"
              stroke-width="7"
              stroke-linecap="round"
            />
            <line
              x1="86"
              y1="92"
              x2="60"
              y2="160"
              stroke="var(--lock-machine-dark)"
              stroke-width="16"
              stroke-linecap="round"
            />
            <line
              x1="86"
              y1="92"
              x2="60"
              y2="160"
              stroke="var(--lock-machine)"
              stroke-width="9"
              stroke-linecap="round"
            />
            <circle
              cx="150"
              cy="142"
              r="8"
              fill="var(--lock-steel-dark)"
            />
            <circle
              cx="86"
              cy="92"
              r="7"
              fill="var(--lock-steel-dark)"
            />

            <!-- Ковш лежит на земле зубьями вниз — им сегодня ничего не копали. -->
            <path
              d="M 44 152 L 78 160 L 74 182 Q 58 194 42 180 Z"
              fill="var(--lock-steel)"
            />
            <path
              d="M 44 186 l 6 6 M 56 190 l 3 7 M 68 186 l 1 7"
              stroke="var(--lock-steel-dark)"
              stroke-width="4"
              stroke-linecap="round"
              fill="none"
            />
          </g>
        </svg>

        <div class="min-w-0 flex-1">
          <B24Alert
            :color="soft ? 'air-primary-warning' : 'air-primary-alert'"
            :title="soft ? 'Акты по выполненным работам не подписаны' : 'Приложение остановлено'"
            :description="soft
              ? 'Отчёты сделаны, выкачены и работают — а вот работа по ним пока не принята. Пожалуйста, подпишите акты по выполненным работам.'
              : 'Акты по выполненным работам не подписаны, работа не принята. Отчёты не открываются, пока это не улажено.'"
          />

          <!--
            ⚠ Срок обязан быть назван. «Подпишите акты» без даты читается как вежливая
            формальность, а «с 21.09 приложение открываться не будет» — как срок с последствием.
            Нет даты на сервере — нет и строки: выдуманный срок хуже отсутствующего.
          -->
          <p
            v-if="soft && hardFrom"
            class="mt-4 text-sm font-medium"
            data-testid="payment-lock-deadline"
          >
            С {{ formatDate(hardFrom) }} приложение открываться не будет.
          </p>

          <template v-if="soft">
            <div
              class="mt-4 h-1.5 w-full overflow-hidden rounded-full"
              style="background-color: var(--lock-track)"
            >
              <div
                class="h-full rounded-full transition-[width] duration-500 ease-linear"
                style="background-color: var(--lock-alarm)"
                :style="{ width: `${progress}%` }"
              />
            </div>
            <p
              class="mt-2 text-sm opacity-70"
              data-testid="payment-lock-countdown"
            >
              Отчёт откроется через {{ secondsLabel(remaining) }}.
            </p>
          </template>

          <template v-else>
            <p class="mt-4 text-sm opacity-70">
              Данные вашей CRM в порядке и никуда не делись: приложение только читает их и никогда
              ничего в них не меняет.
            </p>
            <p class="mt-2 text-sm opacity-70">
              Чтобы снять блокировку, подпишите акты и сообщите об этом исполнителю работ.
            </p>
          </template>
        </div>
      </div>
    </B24Card>
  </div>
</template>

<style scoped>
/*
 * Цвета рисунка — СВОИ, а не палитра диаграмм и не семантические токены b24ui.
 *
 * ⚠ Палитра `--chart-N` занята смыслом «это N-й менеджер в кольце»: взять оттуда жёлтый для
 * кузова значит связать два несвязанных места — поправят палитру ради читаемости секторов, и
 * экскаватор поменяет цвет заодно. А семантические токены темы — это цвета ЗАЛИВКИ элементов
 * интерфейса, у них другой критерий пригодности (CLAUDE.md, «Палитра диаграмм»).
 */
.lock-scene {
  --lock-machine: #eda100;
  --lock-machine-dark: #b87c00;
  --lock-steel: #6b7383;
  --lock-steel-dark: #3a4150;
  --lock-glass: #c3d6e8;
  --lock-ground: #d0d5de;
  --lock-smoke: #9aa3b2;
  --lock-alarm: #d64545;
  --lock-track: #e6eaf0;
}

/*
 * ⚠ Селектор БЕЗ `:global()`, и это не вкусовщина. `:global(.dark) .lock-scene` компилятор
 * scoped-стилей схлопывает в просто `.dark` — проверено на собранном CSS. Переменные при этом
 * уезжают на `<html>`, а `.lock-scene` тут же перебивает их своим светлым набором: тёмная тема
 * молча не применяется, и снимок «в тёмной теме» получается снимком светлой. Обычный потомок
 * работает правильно: атрибут области видимости Vue дописывает только к ПОСЛЕДНЕМУ звену
 * (`.dark .lock-scene[data-v-…]`), а `.dark` живёт на `<html>` — выше компонента, но это
 * по-прежнему предок.
 */
.dark .lock-scene {
  --lock-machine: #c98500;
  --lock-machine-dark: #8f5f00;
  --lock-steel: #5a6373;
  --lock-steel-dark: #272d38;
  --lock-glass: #4d6580;
  --lock-ground: #333a47;
  --lock-smoke: #6d7585;
  --lock-alarm: #c94747;
  --lock-track: #2a2f3a;
}

/*
 * ⚠ Полоса отсчёта и маячок берут цвета из того же набора, но живут ВНЕ `.lock-scene`, поэтому
 * переменные объявлены ещё и на корне компонента. Иначе полоса осталась бы без фона — молча, как
 * это всегда бывает с невычисленной переменной CSS.
 */
[data-testid='payment-lock'] {
  --lock-alarm: #d64545;
  --lock-track: #e6eaf0;
}

.dark [data-testid='payment-lock'] {
  --lock-alarm: #c94747;
  --lock-track: #2a2f3a;
}

/*
 * Стрела дёргается и падает обратно. Это и есть «не работает»: не стоит неподвижно (так выглядит
 * выключенная машина) и не копает (так выглядит работающая), а пытается и не может.
 *
 * ⚠ `transform-box: view-box` обязателен: без него точка поворота считается от рамки самой
 * группы, и стрела улетает в сторону вместо поворота вокруг пальца.
 */
.lock-arm {
  transform-box: view-box;
  transform-origin: 150px 142px;
  animation: lock-arm-try 3.6s ease-in-out infinite;
}

.lock-body {
  transform-box: view-box;
  animation: lock-shake 3.6s ease-in-out infinite;
}

.lock-puff {
  transform-box: view-box;
  transform-origin: 206px 98px;
  opacity: 0;
}

/* Разные длительности — чтобы клубы шли вразнобой: ровный ритм читается как исправная работа. */
.lock-puff-1 { animation: lock-puff 2.4s ease-out infinite; }
.lock-puff-2 { animation: lock-puff 3.1s ease-out 0.7s infinite; }
.lock-puff-3 { animation: lock-puff 2.7s ease-out 1.5s infinite; }

.lock-beacon {
  animation: lock-beacon 1.1s steps(1, end) infinite;
}

@keyframes lock-arm-try {
  0%, 54% { transform: rotate(0deg); }
  59% { transform: rotate(-4deg); }
  63% { transform: rotate(-2.4deg); }
  68% { transform: rotate(-6deg); }
  73% { transform: rotate(-4.6deg); }
  84% { transform: rotate(0.7deg); }
  100% { transform: rotate(0deg); }
}

@keyframes lock-shake {
  0%, 54%, 100% { transform: translate(0, 0); }
  57% { transform: translate(-0.9px, 0.4px); }
  60% { transform: translate(0.9px, -0.4px); }
  64% { transform: translate(-0.7px, 0.3px); }
  68% { transform: translate(0.7px, 0); }
  72% { transform: translate(-0.4px, 0.2px); }
  76% { transform: translate(0.3px, 0); }
}

@keyframes lock-puff {
  0% { opacity: 0; transform: translate(0, 0) scale(0.5); }
  20% { opacity: 0.5; }
  100% { opacity: 0; transform: translate(-12px, -36px) scale(1.6); }
}

@keyframes lock-beacon {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

/*
 * ⚠ Движение отключаемо. Человеку с вестибулярными нарушениями дёргающаяся картинка — не
 * оживление экрана, а недомогание; и экран этот он видит не по своей воле. Без анимации рисунок
 * остаётся осмысленным: стрела опущена, ковш на земле — машина стоит.
 */
@media (prefers-reduced-motion: reduce) {
  .lock-arm,
  .lock-body,
  .lock-puff,
  .lock-beacon {
    animation: none;
  }

  .lock-puff-2 {
    opacity: 0.4;
  }
}
</style>
