import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const markdownFiles = []

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue

    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) collect(absolutePath)
    else if (entry.isFile() && entry.name.endsWith('.md')) markdownFiles.push(absolutePath)
  }
}

collect(repositoryRoot)

const failures = []
const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g

for (const markdownFile of markdownFiles) {
  const content = readFileSync(markdownFile, 'utf8')
  for (const match of content.matchAll(markdownLink)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '')
    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue

    const targetWithoutFragment = decodeURIComponent(rawTarget.split('#', 1)[0])
    const resolvedTarget = resolve(dirname(markdownFile), targetWithoutFragment)
    if (!existsSync(resolvedTarget)) {
      failures.push(`${markdownFile.slice(repositoryRoot.length + 1)} -> ${rawTarget}`)
      continue
    }

    statSync(resolvedTarget)
  }
}

if (failures.length > 0) {
  console.error('Broken local Markdown links:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Checked ${markdownFiles.length} Markdown files: all local links resolve.`)
}
