import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

const alias = {
  '~': fileURLToPath(new URL('./app', import.meta.url))
}

/**
 * Два проекта:
 * - `unit` — чистые функции доменного ядра (node, без DOM и без Nuxt): быстро и без магии;
 * - `nuxt` — компоненты под настоящей средой Nuxt (`defineVitestProject` + happy-dom).
 *
 * Разделение не косметическое: формулы отчёта обязаны проверяться без браузерного окружения —
 * иначе «тест на формулу» незаметно превращается в тест на вёрстку и краснеет от смены разметки.
 */
export default defineConfig(async () => ({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/nuxt/**']
        }
      },
      await defineVitestProject({
        resolve: { alias },
        test: {
          name: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          // ⚠ Публичный адрес приложению нужен: без него страница установки не строит ни адрес
          // обработчика, ни ссылку на раздел портала и падает в «адрес не задан» ещё до первого
          // вызова REST — то есть тест проверял бы заглушку вместо установки.
          environmentOptions: {
            nuxt: { overrides: { runtimeConfig: { public: { siteUrl: 'https://report.example.com' } } } }
          },
          // Холодный старт Nuxt под happy-dom легко перебирает дефолтные 5 с на загруженном CI.
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      })
    ]
  }
}))
