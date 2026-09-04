// Маршруты — из единого источника: из него же строится список пререндера. Копия списка здесь
// означала бы, что новая страница живёт в дев-сервере, но не попадает в статику, — и заметить это
// можно только открыв собранный сайт.
import { fileURLToPath } from 'node:url'
import { PRERENDER_ROUTES } from './app/config/routes'

/** См. `app/utils/emptyModule.ts`: необязательные зависимости `jspdf` в сборку не попадают. */
const EMPTY_MODULE = fileURLToPath(new URL('./app/utils/emptyModule.ts', import.meta.url))

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@bitrix24/b24jssdk-nuxt'
  ],

  // Off: держит агентские dev-сессии и вывод SSG чистыми от шума devtools.
  devtools: { enabled: false },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      /**
       * Публичный адрес, с которого раздаётся приложение. Из него `/install` строит АБСОЛЮТНЫЙ
       * URL обработчика плейсмента для `placement.bind` — относительный Битрикс24 не примет.
       * Задаётся build-time через `NUXT_PUBLIC_SITE_URL` (SSG запекает значение в статику).
       */
      siteUrl: '',
      /** Git-коммит сборки — показывается в подвале. В dev пусто, в CI приезжает `github.sha`. */
      commitSha: ''
    }
  },

  compatibilityDate: '2025-01-15',

  // Страницы приложения не связаны ссылками с публичной страницей, поэтому краулер `generate`
  // их не найдёт — перечисляем явно из `app/config/routes.ts`.
  nitro: {
    prerender: {
      crawlLinks: true,
      routes: PRERENDER_ROUTES
    }
  },

  vite: {
    resolve: {
      alias: {
        html2canvas: EMPTY_MODULE,
        canvg: EMPTY_MODULE,
        dompurify: EMPTY_MODULE
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
