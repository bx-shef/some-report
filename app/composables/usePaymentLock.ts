import {
  LOCK_RELEASE_SECONDS,
  effectiveStage,
  localDayKey,
  lockAppliesTo,
  parseLockOverride,
  parseLockSchedule,
  paymentLockStage,
  type PaymentLockStage
} from '~/utils/paymentLock'

/**
 * Блокировка приложения при неподписанных актах — реактивная обвязка над чистым ядром
 * (`app/utils/paymentLock.ts`). Здесь ровно три вещи, которых у чистых функций быть не может:
 * чтение настроек с сервера, часы и обратный отсчёт.
 *
 * ⚠ Зовётся ОДИН раз, из `app/app.vue`. Это важно не для экономии: `released` живёт ровно столько,
 * сколько живёт приложение, поэтому отсидев двадцать секунд один раз, человек не встречает экран
 * снова на каждом переходе между отчётами. А открыв отчёт заново из меню портала — встречает: там
 * фрейм создаётся с нуля, и это тот самый случай, ради которого напоминание и заведено.
 */

/** Сколько ждём ответа от сервера с настройками, прежде чем решить, что их нет. */
const CONFIG_TIMEOUT_MS = 1200

/** Шаг отсчёта. Полсекунды, а не секунда: подпись меняется вовремя, даже если такт чуть уплыл. */
const TICK_MS = 500

export interface PaymentLockState {
  /** Стадия блокировки: `none`, `soft` (экран с отсчётом) или `hard` (экран навсегда). */
  stage: Readonly<Ref<PaymentLockStage>>
  /** Экран держит страницу прямо сейчас. */
  blocking: ComputedRef<boolean>
  /** Сколько секунд осталось до снятия мягкой блокировки. */
  remaining: Readonly<Ref<number>>
  /**
   * День, с которого приложение перестанет открываться (`YYYY-MM-DD`), если он задан.
   *
   * ⚠ Экран напоминания обязан называть срок. «Подпишите акты» без даты читается как вежливая
   * формальность; «с 21.09 приложение открываться не будет» — как срок, у которого есть
   * последствие. Ради одной этой строки день и доезжает до экрана.
   */
  hardFrom: Readonly<Ref<string | undefined>>
}

export function usePaymentLock(): PaymentLockState {
  const route = useRoute()

  const stage = ref<PaymentLockStage>('none')
  const released = ref(false)
  const remaining = ref(LOCK_RELEASE_SECONDS)
  const hardFrom = ref<string | undefined>()

  const blocking = computed(() => stage.value !== 'none' && !released.value)

  let timer: ReturnType<typeof setInterval> | undefined
  /**
   * ⛔ Снятие таймера регистрируется СИНХРОННО, прямо в setup, а не внутри `onMounted`.
   *
   * `onMounted` здесь асинхронный: к моменту, когда дело доходит до таймера, первый `await` уже
   * случился, активной области видимости эффектов больше нет, и `onScopeDispose` не цепляется
   * НИ К ЧЕМУ — Vue пишет предупреждение в консоль, а таймер продолжает тикать в размонтированном
   * экземпляре. Поймано тестом: предупреждение в выводе оказалось единственным следом.
   */
  onScopeDispose(() => clearInterval(timer))

  /**
   * Настройки с сервера. Пустой объект — это «блокировки нет», и ровно так же трактуется любой
   * отказ.
   *
   * ⛔ Ошибка обязана уводить В СТОРОНУ РАБОТАЮЩЕГО отчёта. Сервер не ответил, ответил мусором,
   * ответил 404 (так ведёт себя дев-сервер — файла там нет вовсе) — приложение работает. Запереть
   * клиента из-за своей же неполадки хуже, чем не показать напоминание: напоминание вернётся
   * завтра, а потерянный рабочий день не вернётся.
   */
  async function readSchedule() {
    try {
      return parseLockSchedule(await $fetch('/payment-lock.json', { timeout: CONFIG_TIMEOUT_MS, retry: 0 }))
    } catch {
      return {}
    }
  }

  onMounted(async () => {
    // Публичная страница и установщик блокировкой не затрагиваются — решаем это ДО запроса, чтобы
    // не ходить на сервер там, где ответ ни на что не влияет.
    if (!lockAppliesTo(route.path)) return

    const schedule = await readSchedule()
    hardFrom.value = schedule.hardFrom
    // ⚠ Расписание и обход складываются ВМЕСТЕ, а не «обход вместо расписания». Иначе `?lock=soft`
    // в день жёсткой блокировки понизил бы её до отсчёта — то есть стал бы ключом от неё.
    stage.value = effectiveStage(
      paymentLockStage(localDayKey(new Date()), schedule),
      parseLockOverride(route.query.lock)
    )
    if (stage.value !== 'soft') return

    // ⚠ Отсчёт ведётся от МОМЕНТА окончания, а не вычитанием по единице на такт. Вкладка в фоне
    // получает такты реже обещанного, и счётчик-вычитатель показывал бы «осталось 14» через минуту
    // после открытия. Здесь же экран просто догоняет реальное время.
    const deadline = Date.now() + LOCK_RELEASE_SECONDS * 1000
    timer = setInterval(() => {
      remaining.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      if (remaining.value > 0) return
      clearInterval(timer)
      released.value = true
    }, TICK_MS)
  })

  return { stage, blocking, remaining, hardFrom }
}
