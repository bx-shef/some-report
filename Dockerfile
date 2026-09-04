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

# ⚠ И самое главное: КАЖДЫЙ инлайновый скрипт каждой собранной страницы обязан иметь хеш в
# итоговом конфиге. «Хотя бы один хеш есть» — проверка, которая однажды уже пропустила в прод
# заблокированную импорт-карту: хеш конфига Nuxt был на месте, а `<script type="importmap">`
# выпал из разбора. Приложение не стартовало вообще, сервер отдавал 200, в логах было пусто.
RUN node --experimental-strip-types --disable-warning=ExperimentalWarning \
      scripts/cspVerify.ts .output/public nginx.conf

# nginx-unprivileged работает не от root и слушает 8080.
FROM nginxinc/nginx-unprivileged:1.31-alpine AS runner
COPY --from=builder /app/.output/public /usr/share/nginx/html

# Конфиг кладём ШАБЛОНОМ: штатный энтрипойнт nginx подставит в него переменные окружения при
# старте контейнера. Так один образ обслуживает и облачные порталы, и коробочные — каждый со
# своим доменом, без пересборки.
COPY --from=builder /app/nginx.conf /etc/nginx/templates/default.conf.template

# Кто может встраивать отчёт и куда он имеет право ходить. По умолчанию — облачные зоны
# Битрикс24; коробочный портал добавляет свой origin в `deploy/.env`.
#
# ⚠ Значение по умолчанию обязано быть непустым. Пустой список в `frame-ancestors` запрещает
# встраивание ВСЕМ, и портал показал бы пустую область без единой ошибки в интерфейсе.
# ⚠ Ограничиваем энтрипойнт ОДНОЙ переменной. По умолчанию он подставляет в шаблон ВСЕ
# переменные окружения, а конфиг nginx полон собственных `$uri`, `$host`, `$request_uri`. Совпади
# имя переменной окружения с именем директивы nginx — и конфиг молча поедет: `error_page 405 =200
# $uri` превратился бы в `error_page 405 =200`, то есть портал снова увидел бы пустоту вместо
# отчёта. Фильтр делает подстановку ровно той, что описана здесь.
ENV NGINX_ENVSUBST_FILTER="B24_PORTAL_ORIGINS"

ENV B24_PORTAL_ORIGINS="https://*.bitrix24.ru https://*.bitrix24.by https://*.bitrix24.com https://*.bitrix24.eu https://*.bitrix24.kz https://*.bitrix24.ua https://*.bitrix24.de https://*.bitrix24.fr https://*.bitrix24.it https://*.bitrix24.pl https://*.bitrix24.es https://*.bitrix24.uk https://*.bitrix24.com.br https://*.bitrix24.com.tr https://*.bitrix24.mx https://*.bitrix24.co https://*.bitrix24.cn https://*.bitrix24.in https://*.bitrix24.id https://*.bitrix24.jp https://*.bitrix24.vn https://*.bitrix24.tech"

# ⚠ Проверяем ИТОГОВЫЙ конфиг на этапе сборки — с подставленными хешами И подставленной
# переменной. Синтаксическая ошибка должна ронять образ здесь, а не всплывать при выкате, когда
# контейнер уже не поднимается и сайт отдаёт 503.
#
# Временный `default.conf` тут же удаляем: при старте его напишет энтрипойнт из шаблона, и файл,
# оставшийся от сборки, читался бы как «конфиг уже есть» при разборе неполадок.
RUN envsubst '${B24_PORTAL_ORIGINS}' \
      < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf \
    && nginx -t \
    && rm /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
