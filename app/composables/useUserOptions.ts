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
   * Одна настройка МИМО кэша — для значений, которые только что записал другой фрейм.
   *
   * ⚠ Кэш здесь врал бы: он существует ради отбора, который «за минуту не меняется», а условие
   * детализации пишется ровно перед открытием слайдера и читается в СВЕЖЕМ фрейме. Прочитай мы
   * его из кэша страницы — открылось бы прошлое условие под новым заголовком.
   */
  async function readFresh(key: string): Promise<unknown> {
    if (!b24.isInit()) return undefined
    try {
      const result = await b24.getOrThrow().actions.v2.call.make<Record<string, unknown>>({
        method: 'user.option.get',
        params: {}
      })
      if (!result.isSuccess) return undefined
      const data = result.getData()?.result
      return typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)[key]
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Записать и ДОЖДАТЬСЯ ответа портала. `false` — не записалось.
   *
   * ⚠ Отдельно от `write`, потому что смысл другой. `write` — «запомни отбор на следующий раз»,
   * и его провал стоит одного лишнего выбора в интерфейсе. Здесь запись — ПЕРЕДАЧА данных
   * другому фрейму: открой мы слайдер, не дождавшись её, он прочитал бы прошлое условие и показал
   * бы чужой список под верным заголовком. Поэтому ждём и отвечаем честно.
   *
   * ⚠ И без дедупликации по последнему значению: то же самое условие, открытое второй раз, —
   * законный повтор, а не лишний запрос.
   */
  async function writeNow(key: string, value: string): Promise<boolean> {
    if (!b24.isInit()) return false
    try {
      const result = await b24.getOrThrow().actions.v2.call.make({
        method: 'user.option.set',
        params: { options: { [key]: value } }
      })
      return result.isSuccess
    } catch {
      return false
    }
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

  return { read, readFresh, write, writeNow }
}
