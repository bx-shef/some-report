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

  it('проход для тестов берёт тесты, сборочные скрипты и конфиг Vitest', () => {
    const include = readJsonc('tsconfig.node.json').include as string[]
    expect(include).toContain('tests/**/*.ts')
    // `scripts/**` — сборочные скрипты вроде cspHashes.ts. Они не в приложении, значит основной
    // проход их не видит; без этой строки они не проверялись бы типами вовсе, а ломают они выкат.
    expect(include).toContain('scripts/**/*.ts')
    expect(include).toContain('vitest.config.ts')
  })

  // Nuxt-тесты проверяет основной проход: только там подключены авто-импорты. Если Nuxt
  // перестанет включать их в свой tsconfig, они выпадут из проверки бесшумно — вот об этом тест.
  it('nuxt-тесты попадают в основной проход', () => {
    const include = readJsonc('.nuxt/tsconfig.json').include as string[]
    expect(include.some(p => p.includes('tests/nuxt'))).toBe(true)
  })

  it('nuxt-тесты исключены из node-прохода — иначе они краснеют на авто-импортах', () => {
    expect(readJsonc('tsconfig.node.json').exclude as string[]).toContain('tests/nuxt')
  })

  it('каждый файл тестов покрыт ровно одним проходом', () => {
    const files = execSync('git ls-files "tests/**/*.ts"', { cwd: repoRoot })
      .toString().trim().split('\n').filter(Boolean)
    expect(files.length).toBeGreaterThan(0)
    // `tests/nuxt/**` — основной проход (там авто-импорты), всё остальное под `tests/` — node-проход.
    // Третьего места нет: файл, не попавший ни туда ни туда, типами не проверяется вовсе.
    const orphans = files.filter(f => !f.startsWith('tests/nuxt/') && !f.startsWith('tests/'))
    expect(orphans, `вне обоих проходов:\n${orphans.join('\n')}`).toEqual([])
  })

  // `pnpm smoke` здесь по той же причине: убрать шаг из workflow — самый тихий способ вернуть
  // дыру с импорт-картой, и без сторожа этого не заметит никто.
  it('CI гоняет lint, test, typecheck, сборку и браузерный смоук CSP', () => {
    const ci = read('.github/workflows/ci.yml')
    for (const step of ['pnpm lint', 'pnpm test', 'pnpm typecheck', 'pnpm generate', 'pnpm smoke', 'pnpm smoke:image']) {
      expect(ci).toContain(step)
    }
  })

  // `continue-on-error: true` делает шаг красным, а джобу зелёной — самый тихий способ погасить
  // проверку. Понадобится законное исключение — автор придёт сюда и напишет, почему провал шага
  // не должен ронять сборку. Этот разговор и есть цель гарда.
  it('ни один шаг CI не помечен continue-on-error', () => {
    expect(read('.github/workflows/ci.yml')).not.toContain('continue-on-error')
  })

  // Боевой образ обязан собираться на КАЖДОМ PR. Иначе поломка Dockerfile или базового образа
  // всплывает только на выкате с main — то есть тогда, когда чинить её уже некогда.
  it('CI собирает боевой образ на PR', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('docker-build')
    expect(ci).toContain('target: runner')
  })

  // Выкат заперт за зелёным CI (`needs: ci`) и только с main. Снятие любого из двух условий
  // означает, что в GHCR может уехать непроверенный образ.
  it('выкат зависит от CI и ограничен веткой main', () => {
    const deploy = read('.github/workflows/ci.yml').split('  deploy:')[1] ?? ''
    expect(deploy).toContain('needs: ci')
    expect(deploy).toContain('github.ref == \'refs/heads/main\'')
  })
})
