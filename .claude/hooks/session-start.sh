#!/bin/bash
# SessionStart-хук для Claude Code в вебе: ставит зависимости и готовит Nuxt, чтобы
# lint / typecheck / test / build работали с первого хода, а не после ручного install.
# Синхронный намеренно — это гарантия, что к началу сессии зависимости на месте.
set -euo pipefail

# Нужен только в удалённом (веб) окружении; локальные клоны управляют зависимостями сами.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# corepack поднимает pnpm той версии, что закреплена в "packageManager" в package.json.
corepack enable >/dev/null 2>&1 || true

# Идемпотентно: при актуальных store и node_modules это no-op.
pnpm install --frozen-lockfile

# Генерирует .nuxt/ (конфиг eslint и tsconfig'и), от которых зависят lint и typecheck.
# `postinstall` уже зовёт `nuxt prepare`, но оставляем явно — на случай, если install
# оказался пропущен как актуальный.
pnpm exec nuxi prepare
