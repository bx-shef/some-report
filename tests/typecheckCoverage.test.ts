import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Гард охвата типами.
 *
 * `pnpm typecheck` идёт ДВУМЯ проходами с разными наборами файлов, и это легко сломать молча:
 * убрать проход из скрипта или сузить `include` — обе правки выглядят безобидной уборкой, обе
 * оставляют CI зелёным, и обе снимают проверку типов с половины репозитория. Здесь мы проверяем
 * не «компилируется ли», а «смотрят ли вообще».
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function read(file: string): string {
  return readFileSync(join(repoRoot, file), 'utf-8')
}

/** JSON с комментариями — tsconfig'и их допускают, а `JSON.parse` нет. */
function readJsonc(file: string): Record<string, unknown> {
  return JSON.parse(read(file).replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>
}

const typecheckScript = (JSON.parse(read('package.json')) as {
  scripts: Record<string, string>
}).scripts.typecheck!

describe('охват typecheck', () => {
  it('скрипт гоняет оба прохода — приложение и тесты', () => {
    expect(typecheckScript).toContain('vue-tsc --noEmit')
    expect(typecheckScript).toContain('tsconfig.node.json')
  })

  it('проход для тестов берёт корневые тесты и конфиг Vitest', () => {
    const include = readJsonc('tsconfig.node.json').include as string[]
    expect(include).toContain('tests/*.ts')
    expect(include).toContain('vitest.config.ts')
  })

  // Nuxt-тесты проверяет основной проход: только там подключены авто-импорты. Если Nuxt
  // перестанет включать их в свой tsconfig, они выпадут из проверки бесшумно — вот об этом тест.
  it('nuxt-тесты попадают в основной проход', () => {
    const include = readJsonc('.nuxt/tsconfig.json').include as string[]
    expect(include.some(p => p.includes('tests/nuxt'))).toBe(true)
  })

  it('каждый файл тестов покрыт ровно одним проходом', () => {
    const files = execSync('git ls-files "tests/**/*.ts"', { cwd: repoRoot })
      .toString().trim().split('\n').filter(Boolean)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const isNuxt = file.startsWith('tests/nuxt/')
      // Корневые — в node-проходе, вложенные nuxt — в основном. Третьего места нет.
      expect(isNuxt || /^tests\/[^/]+\.ts$/.test(file), `нераспознанный путь: ${file}`).toBe(true)
    }
  })

  it('CI гоняет lint, test, typecheck и сборку', () => {
    const ci = read('.github/workflows/ci.yml')
    for (const step of ['pnpm lint', 'pnpm test', 'pnpm typecheck', 'pnpm generate']) {
      expect(ci).toContain(step)
    }
  })

  // `continue-on-error: true` делает шаг красным, а джобу зелёной — самый тихий способ погасить
  // проверку. Понадобится законное исключение — автор придёт сюда и напишет, почему провал шага
  // не должен ронять сборку. Этот разговор и есть цель гарда.
  it('ни один шаг CI не помечен continue-on-error', () => {
    expect(read('.github/workflows/ci.yml')).not.toContain('continue-on-error')
  })
})
