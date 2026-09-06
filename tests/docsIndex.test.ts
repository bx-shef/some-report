import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Каждый документ в `docs/` обязан быть во всех трёх индексах: `docs/README.md`, таблице
 * «Документация» в `CLAUDE.md` и таблице в корневом `README.md` — его на GitHub видят первым.
 *
 * Гард нужен потому, что документ, которого нет в индексе, для читателя не существует: ТЗ
 * заказчика, лежащее в `docs/`, но не упомянутое нигде, — это то же самое, что переписка.
 * Заводится дёшево, ломается ровно в тот момент, когда кто-то добавил файл и забыл про индекс.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function docsFiles(): string[] {
  return execSync('git ls-files "docs/*.md"', { cwd: repoRoot })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(path => basename(path))
    .filter(name => name !== 'README.md')
}

describe('индекс документации', () => {
  const docsIndex = readFileSync(join(repoRoot, 'docs', 'README.md'), 'utf-8')
  const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8')
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8')

  it('в docs/ есть документы', () => {
    expect(docsFiles().length).toBeGreaterThan(0)
  })

  it.each(docsFiles())('%s упомянут в docs/README.md, CLAUDE.md и README.md', (name) => {
    expect(docsIndex, `docs/README.md не ссылается на ${name}`).toContain(`](${name})`)
    expect(claude, `CLAUDE.md не ссылается на docs/${name}`).toContain(`](docs/${name})`)
    expect(readme, `README.md не ссылается на docs/${name}`).toContain(`](docs/${name})`)
  })
})
