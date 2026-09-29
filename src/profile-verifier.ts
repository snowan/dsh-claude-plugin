import { Buffer } from 'node:buffer'
import { parseDocument } from 'yaml'
import { canonicalJson } from './canonical-json.js'

export const PROFILE_VERIFIER_SCHEMA_VERSION = 1
export const MAX_PROFILE_DUMP_BYTES = 8 * 1_024 * 1_024
export const CLAUDE_ADAPTER_ROW_ID = 'llm-claude-code'
export const DEFAULT_MODEL_ROW_ID = 'agent-default-model'

export interface ProfileVerificationIssue {
  readonly code: string
  readonly summary: string
}

export interface ProfileVerificationReport {
  readonly schemaVersion: typeof PROFILE_VERIFIER_SCHEMA_VERSION
  readonly pass: boolean
  readonly beforeRows: number
  readonly installedRows: number
  readonly removedRows?: number
  readonly allowedChangedRowIds: readonly string[]
  readonly issues: readonly ProfileVerificationIssue[]
}

type ConfigRow = Readonly<Record<string, unknown>> & { readonly id: string }

function issue(code: string, summary: string): ProfileVerificationIssue {
  return Object.freeze({ code, summary })
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}

function parseRows(label: string, source: string): ConfigRow[] {
  if (Buffer.byteLength(source, 'utf8') > MAX_PROFILE_DUMP_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_PROFILE_DUMP_BYTES}-byte profile dump bound`)
  }
  const document = parseDocument(source, { strict: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`${label} is not valid YAML`)
  }
  const unsupportedWarning = document.warnings.find(
    (warning) =>
      warning.code !== 'TAG_RESOLVE_FAILED' || !warning.message.includes('tag:yaml.org,2002:js'),
  )
  if (unsupportedWarning !== undefined) {
    throw new Error(`${label} contains an unsupported YAML warning`)
  }
  const value: unknown = document.toJS({ mapAsMap: false, maxAliasCount: 0 })
  if (!Array.isArray(value)) throw new Error(`${label} must be a top-level YAML array`)
  const rows: ConfigRow[] = []
  const ids = new Set<string>()
  for (const [index, row] of value.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${label}[${index}] must be an object row`)
    }
    const record = row as Record<string, unknown>
    if (
      typeof record.id !== 'string' ||
      record.id.length === 0 ||
      record.id.length > 256 ||
      hasControlCharacter(record.id)
    ) {
      throw new Error(`${label}[${index}] has an invalid row ID`)
    }
    if (ids.has(record.id)) throw new Error(`${label} repeats row ID ${JSON.stringify(record.id)}`)
    ids.add(record.id)
    rows.push(record as ConfigRow)
  }
  return rows
}

function byId(rows: readonly ConfigRow[]): ReadonlyMap<string, ConfigRow> {
  return new Map(rows.map((row) => [row.id, row]))
}

function equal(left: unknown, right: unknown): boolean {
  try {
    const invalid = (message: string) => new Error(message)
    return canonicalJson(left, invalid) === canonicalJson(right, invalid)
  } catch {
    return false
  }
}

function expectedInstalledDefault(before: ConfigRow): ConfigRow {
  return {
    ...before,
    config: { provider: 'claude-code', model: 'default' },
  }
}

function verifyInstalled(
  before: readonly ConfigRow[],
  installed: readonly ConfigRow[],
): ProfileVerificationIssue[] {
  const issues: ProfileVerificationIssue[] = []
  const baseline = byId(before)
  const current = byId(installed)
  if (baseline.has(CLAUDE_ADAPTER_ROW_ID)) {
    issues.push(
      issue(
        'PROFILE_BASELINE_ALREADY_HAS_CLAUDE',
        `Baseline already contains ${CLAUDE_ADAPTER_ROW_ID}`,
      ),
    )
  }
  const adapter = current.get(CLAUDE_ADAPTER_ROW_ID)
  if (
    adapter === undefined ||
    !equal(adapter, { id: CLAUDE_ADAPTER_ROW_ID, name: 'dsh-claude-plugin' })
  ) {
    issues.push(
      issue(
        'PROFILE_CLAUDE_ROW_INVALID',
        'Installed tree must add exactly the dsh-claude-plugin adapter row',
      ),
    )
  }
  const beforeDefault = baseline.get(DEFAULT_MODEL_ROW_ID)
  const installedDefault = current.get(DEFAULT_MODEL_ROW_ID)
  if (beforeDefault === undefined) {
    issues.push(
      issue(
        'PROFILE_BASELINE_DEFAULT_MODEL_MISSING',
        `Baseline is missing ${DEFAULT_MODEL_ROW_ID}`,
      ),
    )
  } else if (
    installedDefault === undefined ||
    !equal(installedDefault, expectedInstalledDefault(beforeDefault))
  ) {
    issues.push(
      issue(
        'PROFILE_DEFAULT_MODEL_INVALID',
        'Installed tree must change only the default model row config to claude-code/default',
      ),
    )
  }
  const expectedIds = new Set([...baseline.keys(), CLAUDE_ADAPTER_ROW_ID])
  const expectedOrder = [...baseline.keys(), CLAUDE_ADAPTER_ROW_ID]
  if (!equal([...current.keys()], expectedOrder)) {
    issues.push(
      issue(
        'PROFILE_ROW_ORDER_CHANGED',
        'Installed tree must preserve baseline row order and append the Claude adapter row',
      ),
    )
  }
  for (const id of expectedIds) {
    if (!current.has(id)) {
      issues.push(
        issue('PROFILE_ROW_MISSING', `Installed tree is missing row ${JSON.stringify(id)}`),
      )
    }
  }
  for (const id of current.keys()) {
    if (!expectedIds.has(id)) {
      issues.push(
        issue('PROFILE_ROW_ADDED', `Installed tree adds unexpected row ${JSON.stringify(id)}`),
      )
    }
  }
  for (const [id, row] of baseline) {
    if (id === DEFAULT_MODEL_ROW_ID || id === CLAUDE_ADAPTER_ROW_ID) continue
    const after = current.get(id)
    if (after !== undefined && !equal(row, after)) {
      issues.push(
        issue('PROFILE_ROW_CHANGED', `Installed tree changes protected row ${JSON.stringify(id)}`),
      )
    }
  }
  return issues
}

function verifyRemoved(
  before: readonly ConfigRow[],
  removed: readonly ConfigRow[],
): ProfileVerificationIssue[] {
  if (equal(before, removed)) return []
  const issues: ProfileVerificationIssue[] = []
  const baseline = byId(before)
  const current = byId(removed)
  if (!equal([...baseline.keys()], [...current.keys()])) {
    issues.push(
      issue('PROFILE_REMOVE_ORDER_CHANGED', 'Removed tree does not restore baseline row order'),
    )
  }
  for (const [id, row] of baseline) {
    const after = current.get(id)
    if (after === undefined) {
      issues.push(
        issue('PROFILE_REMOVE_ROW_MISSING', `Removed tree is missing row ${JSON.stringify(id)}`),
      )
    } else if (!equal(row, after)) {
      issues.push(
        issue('PROFILE_REMOVE_ROW_CHANGED', `Removed tree changes row ${JSON.stringify(id)}`),
      )
    }
  }
  for (const id of current.keys()) {
    if (!baseline.has(id)) {
      issues.push(
        issue(
          'PROFILE_REMOVE_ROW_REMAINS',
          `Removed tree retains unexpected row ${JSON.stringify(id)}`,
        ),
      )
    }
  }
  return issues
}

/** Proves install changes only the adapter/default-model rows and optional removal restores baseline. */
export function verifyProfileTransition(
  beforeDump: string,
  installedDump: string,
  removedDump?: string,
): ProfileVerificationReport {
  let before: ConfigRow[] = []
  let installed: ConfigRow[] = []
  let removed: ConfigRow[] | undefined
  const issues: ProfileVerificationIssue[] = []
  try {
    before = parseRows('before dump', beforeDump)
  } catch (error: unknown) {
    issues.push(
      issue(
        'PROFILE_BEFORE_INVALID',
        error instanceof Error ? error.message : 'before dump is invalid',
      ),
    )
  }
  try {
    installed = parseRows('installed dump', installedDump)
  } catch (error: unknown) {
    issues.push(
      issue(
        'PROFILE_INSTALLED_INVALID',
        error instanceof Error ? error.message : 'installed dump is invalid',
      ),
    )
  }
  if (removedDump !== undefined) {
    try {
      removed = parseRows('removed dump', removedDump)
    } catch (error: unknown) {
      issues.push(
        issue(
          'PROFILE_REMOVED_INVALID',
          error instanceof Error ? error.message : 'removed dump is invalid',
        ),
      )
    }
  }
  if (issues.length === 0) issues.push(...verifyInstalled(before, installed))
  if (issues.length === 0 && removed !== undefined) issues.push(...verifyRemoved(before, removed))
  return Object.freeze({
    schemaVersion: PROFILE_VERIFIER_SCHEMA_VERSION,
    pass: issues.length === 0,
    beforeRows: before.length,
    installedRows: installed.length,
    ...(removed === undefined ? {} : { removedRows: removed.length }),
    allowedChangedRowIds: Object.freeze([CLAUDE_ADAPTER_ROW_ID, DEFAULT_MODEL_ROW_ID]),
    issues: Object.freeze(issues),
  })
}
