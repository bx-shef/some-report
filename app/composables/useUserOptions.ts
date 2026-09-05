/**
 * Настройки отчёта, запомненные порталом за конкретным человеком (`user.option.get/set`).
 *
 * Зачем: отбор в обоих отчётах руководитель выставляет один и тот же изо дня в день — своё
 * направление, свой период, свою компанию. Заставлять выбирать его заново при каждом открытии
 * фрейма значит требовать пяти нажатий ради того, что не менялось месяц.
 *
 * ⚠ Это ЕДИНСТВЕННОЕ место, где приложение что-то ПИШЕТ в портал, и пишет оно только свою
 * настройку: `user.option.set` кладёт значение в пару «наше приложение + текущий пользователь» и
 * не касается ни CRM, ни чужих данных. Отдельного права метод не требует (scope «базовый»).
 *
 * ⚠ Любая ошибка здесь глушится: отчёт обязан открыться и без сохранённого отбора. Портал может
 * ответить лимитом запросов, а вне фрейма (предпросмотр) SDK нет вовсе — и ни то, ни другое не
 * повод показать человеку красную плашку вместо чисел.
 */
export function useUserOptions() {
  const b24 = useB24()
  /** Прочитанные настройки: спрашиваем один раз на страницу — за минуту они не меняются. */
  let cache: Promise<Record<string, unknown>> | undefined
  /** Что уже записано: повторная запись того же значения — лишний запрос к порталу. */
  const written = new Map<string, string>()

  function readAll(): Promise<Record<string, unknown>> {
    if (cache) return cache
    const attempt = (async () => {
      if (!b24.isInit()) return {}
      try {
        const result = await b24.getOrThrow().actions.v2.call.make<Record<string, unknown>>({
          method: 'user.option.get',
          params: {}
        })
        if (!result.isSuccess) return {}
        const data = result.getData()?.result
        return typeof data === 'object' && data !== null && !Array.isArray(data)
          ? data as Record<string, unknown>
          : {}
      } catch {
        return {}
      }
    })()
    cache = attempt
    return attempt
  }

  /** Одна настройка. `undefined` — её нет либо портал не ответил: это одно и то же для отчёта. */
  async function read(key: string): Promise<unknown> {
    return (await readAll())[key]
  }

  /**
   * Записать настройку.
   *
   * ⚠ Ничего не ждём и ничего не показываем: запись идёт следом за сменой отбора, а следом за
   * ней уже идёт выборка отчёта на десяток секунд. Ошибка записи значит только «в следующий раз
   * откроется с прежним отбором».
   */
  function write(key: string, value: string): void {
    if (!b24.isInit() || written.get(key) === value) return
    written.set(key, value)
    void (async () => {
      try {
        await b24.getOrThrow().actions.v2.call.make({ method: 'user.option.set', params: { options: { [key]: value } } })
      } catch {
        // Не записалось — отбор просто не запомнится. Повторять незачем: следующая смена отбора
        // запишет снова, а «висящая» очередь повторов на фоне отчёта опаснее забытой настройки.
        written.delete(key)
      }
    })()
  }

  return { read, write }
}
