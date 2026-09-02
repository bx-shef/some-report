# Статика отчёта за nginx. Backend'а у приложения нет — образ ровно один.
#
# Сборка многоступенчатая: зависимости → генерация статики → голый nginx с результатом.
# В финальный образ не попадают ни node_modules, ни исходники.

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: ставим ровно то, что в коммите, — сборка воспроизводима и совпадает с CI.
# --ignore-scripts: пропускаем postinstall (`nuxt prepare`); `nuxt generate` дальше зовёт его сам.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .

# ⚠ Публичный адрес приложения. Из него страница установки строит АБСОЛЮТНЫЙ адрес обработчика
# плейсмента — относительный `placement.bind` не примет. Значение build-time: SSG запекает его в
# статику, поэтому подменить его на работающем сервере нельзя, нужна пересборка.
ARG NUXT_PUBLIC_SITE_URL
ENV NUXT_PUBLIC_SITE_URL=$NUXT_PUBLIC_SITE_URL
# Коммит сборки — показывается в подвале и помогает понять, что именно открыто в портале.
ARG NUXT_PUBLIC_COMMIT_SHA
ENV NUXT_PUBLIC_COMMIT_SHA=$NUXT_PUBLIC_COMMIT_SHA

RUN pnpm generate

# --- Гарды на СОБРАННОМ артефакте ---------------------------------------------------------------
# Тесты проверяют исходники, эти проверки — то, что реально уехало в образ. Разница между ними и
# есть место, где живут молчаливые дефекты выката.
#
# Фигурные скобки, а НЕ круглые: `exit 1` внутри `( … )` выходит только из подоболочки, и сборка
# продолжилась бы как ни в чём не бывало.

# Без страницы установки приложение невозможно поставить в портал.
RUN test -s .output/public/install/index.html \
      || { echo 'СБОРКА: нет /install — приложение нельзя установить в портал'; exit 1; }
RUN test -s .output/public/app/index.html \
      || { echo 'СБОРКА: нет /app — открывать в портале нечего'; exit 1; }
# `404.html` — цель `error_page`. Пропади он, и nginx уйдёт в цикл внутренних редиректов,
# отдавая 500 на каждую опечатку в адресе.
RUN test -s .output/public/404.html \
      || { echo 'СБОРКА: нет 404.html — error_page уедет в цикл'; exit 1; }

# Подстановка sha256-хешей инлайновых скриптов в CSP (см. scripts/cspHashes.ts).
# Считать их надо по СОБРАННОМУ HTML: `buildId` внутри `window.__NUXT__.config` свой на каждую
# сборку, и хеш, посчитанный заранее, не совпал бы.
RUN node --experimental-strip-types --disable-warning=ExperimentalWarning \
      scripts/cspHashes.ts .output/public nginx.conf

# ⚠ Плейсхолдер обязан исчезнуть. Останься он — браузер увидит в `script-src` мусорный токен,
# заблокирует собственный бандл приложения и покажет белый экран. В логе сервера при этом не будет
# ни строчки: CSP нарушает КЛИЕНТ.
RUN ! grep -q '__CSP_SCRIPT_HASHES__' nginx.conf \
      || { echo 'CSP: плейсхолдер не заменён — приложение заблокирует само себя'; exit 1; }
RUN grep -q "sha256-" nginx.conf \
      || { echo 'CSP: в конфиг не попало ни одного хеша'; exit 1; }

# nginx-unprivileged работает не от root и слушает 8080.
FROM nginxinc/nginx-unprivileged:1.31-alpine AS runner
COPY --from=builder /app/.output/public /usr/share/nginx/html
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf
# Проверяем ИТОГОВЫЙ конфиг (хеши уже подставлены) на этапе сборки: синтаксическая ошибка должна
# ронять образ здесь, а не всплывать при выкате.
RUN nginx -t
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
