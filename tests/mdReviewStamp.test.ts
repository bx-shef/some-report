import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Конвенция штампа ревью (см. CLAUDE.md › Конвенции): каждый отслеживаемый `.md` несёт строку
 * `> Last reviewed: YYYY-MM-DD` блок-цитатой сразу под заголовком H1.
 *
 * Гард нужен потому, что документ без даты не отличим от документа, который никто не перечитывал
 * полгода, — а именно по документации здесь решают спор о числах.
 */
const STAMP_RE = /^> Last reviewed: \d{4}-\d{2}-\d{2}$/m

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** `.md`, отслеживаемые git — то есть без `node_modules/` и `.nuxt/`. */
function trackedMdFiles(): string[] {
  return execSync('git ls-files "*.md"', { cwd: repoRoot })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
}

describe('штамп ревью в markdown', () => {
  it('git вообще отдаёт список файлов', () => {
    expect(trackedMdFiles().length).toBeGreaterThan(0)
  })

  it('каждый отслеживаемый .md несёт «> Last reviewed: YYYY-MM-DD»', () => {
    const missing = trackedMdFiles().filter(
      f => !STAMP_RE.test(readFileSync(join(repoRoot, f), 'utf-8'))
    )
    expect(missing, `Нет штампа ревью в:\n${missing.join('\n')}`).toEqual([])
  })
})
