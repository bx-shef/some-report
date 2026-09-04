#!/bin/sh
# Проверка B24_PORTAL_ORIGINS ПЕРЕД тем, как штатный энтрипойнт nginx подставит её в конфиг.
#
# ⚠ envsubst — тупая текстовая подстановка, синтаксис nginx он не понимает. Значение с кавычкой,
# точкой с запятой или переводом строки попадает ВНУТРЬ строки `add_header … "…"` и разрывает её:
#   B24_PORTAL_ORIGINS='https://evil" always; add_header X-Pwned "yes'
# даёт синтаксически ВЕРНЫЙ конфиг, в котором из CSP выпал `frame-ancestors` целиком (снята защита
# от кликджекинга), а рядом добавился чужой заголовок. Голая `*` снимает ту же защиту без единой
# ошибки. Поэтому: только `https://host` или `https://*.host`, через пробел, ничего больше —
# иначе контейнер НЕ СТАРТУЕТ. Это лучше, чем тихо отдавать испорченный заголовок.
#
# Имя файла с `05-` — раньше штатного `20-envsubst-on-templates.sh`.
set -eu
# ⚠ Без `set -f` шелл раскрыл бы `*` и `https://*.bitrix24.by` по файлам текущего каталога — и
# голая звёздочка проходила бы проверку под именем случайного файла.
set -f

value="${B24_PORTAL_ORIGINS:-}"
if [ -z "$value" ]; then
  echo "B24_PORTAL_ORIGINS пуста: без списка порталов встраивание запрещено всем" >&2
  exit 1
fi

# Каждый токен — https://имя-хоста, опционально с wildcard-префиксом `*.`. Больше ничего.
for token in $value; do
  case "$token" in
    https://\*.*) host="${token#https://\*.}" ;;
    https://*) host="${token#https://}" ;;
    *) echo "B24_PORTAL_ORIGINS: «$token» — допустимы только https://хост и https://*.хост" >&2; exit 1 ;;
  esac
  case "$host" in
    ''|*[!a-zA-Z0-9.-]*|.*|*.|*..*)
      echo "B24_PORTAL_ORIGINS: «$token» — некорректное имя хоста" >&2; exit 1 ;;
  esac
done
echo "[csp] B24_PORTAL_ORIGINS: $(echo "$value" | wc -w | tr -d ' ') origin(ов), все допустимы"
