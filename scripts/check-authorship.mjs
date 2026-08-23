import { execFileSync } from 'node:child_process'

const ALLOWED_AUTHORS = new Set(['snowan\txiaowei.wan89@gmail.com'])

const authors = execFileSync('git', ['log', '--format=%an%x09%ae'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)

const unexpected = [...new Set(authors.filter((author) => !ALLOWED_AUTHORS.has(author)))]
if (unexpected.length > 0) {
  throw new Error(`Unexpected Git author(s): ${unexpected.join(', ')}`)
}

const messages = execFileSync('git', ['log', '--format=%B%x00'], {
  encoding: 'utf8',
})
if (/^co-authored-by:/imu.test(messages)) {
  throw new Error('Co-authored-by trailer found; credit Codex in AUTHORS.md instead')
}

console.log(`Checked ${authors.length} commit(s): authorship is limited to snowan`)
