import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { deflateSync } from 'node:zlib'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema as McpToolSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  BENCHMARK_SCHEMA_VERSION,
  analyzeBenchmark,
  benchmarkTerminalSuccess,
  benchmarkTranscriptInvariant,
  digestBenchmarkText,
  renderBenchmarkMarkdown,
  validateBenchmarkObservation,
} from '../lib/benchmark.js'
import { runDoctor, resolveDoctorExecutable } from '../lib/doctor.js'
import { MCP_ALWAYS_LOAD_META } from '../lib/tool-server.js'
import { sdkEnvironment } from '../lib/process.js'
import * as claudePlugin from '../lib/index.js'

const EXPECTED_DSH_VERSION = '0.2.0-rc.2'
const MAX_ITERATIONS = 12
const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 15 * 60_000
const MAX_RESULT_BYTES = 1 * 1_024 * 1_024
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scenarioPath = join(repository, 'bench', 'scenarios.json')
const sdkManifestPath = findPackageManifest('@anthropic-ai/claude-agent-sdk')
const scenarioFixture = JSON.parse(readFileSync(scenarioPath, 'utf8'))
const sdkManifest = JSON.parse(readFileSync(sdkManifestPath, 'utf8'))

const parsed = parseArgs({
  options: {
    live: { type: 'boolean' },
    preflight: { type: 'boolean' },
    list: { type: 'boolean' },
    quick: { type: 'boolean' },
    scenario: { type: 'string', multiple: true },
    model: { type: 'string' },
    effort: { type: 'string' },
    warmups: { type: 'string' },
    repetitions: { type: 'string' },
    'timeout-ms': { type: 'string' },
    results: { type: 'string' },
    report: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: false,
})

const HELP = `Usage: node scripts/benchmark.mjs [mode] [options]

Modes:
  --preflight          Run the authenticated doctor gate only (default)
  --live               Run paired direct-SDK and DSH-plugin measurements
  --list               List scenario IDs without invoking Claude

Options:
  --scenario ID        Select a scenario; repeat the option to select several
  --model MODEL        Use the same Claude model alias in both lanes (default: sonnet)
  --effort LEVEL       low, medium, or high (default: medium)
  --warmups N          Warm-ups per scenario (default: 1)
  --repetitions N      Measured pairs per scenario (default: 5)
  --quick              Use zero warm-ups and one measured pair; never makes latency claims
  --timeout-ms N       Per-lane deadline (default: 180000)
  --results PATH       Sanitized JSONL destination
  --report PATH        Markdown analysis destination
  -h, --help           Show this help

The live mode intentionally incurs Claude usage. It refuses to start unless the
host-only doctor proves authentication, SDK startup, MCP isolation, generation,
and process cleanup. Reports never contain prompts, output text, tool arguments,
tool results, provider errors, credentials, environment values, or local paths.
`

class BenchmarkFailure extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BenchmarkFailure'
    this.code = code
  }
}

class MessageQueue {
  #values = []
  #waiters = []
  #closed = false

  push(value) {
    if (this.#closed) throw new BenchmarkFailure('QUEUE_CLOSED', 'benchmark input queue is closed')
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#values.push(value)
    else waiter({ done: false, value })
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  next() {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolveNext) => this.#waiters.push(resolveNext))
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

function findPackageManifest(name) {
  const entry = import.meta.resolve(name)
  let directory = dirname(fileURLToPath(entry))
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) {
      const value = JSON.parse(readFileSync(candidate, 'utf8'))
      if (value.name === name) return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new BenchmarkFailure('PACKAGE_MANIFEST_MISSING', `could not locate ${name}`)
}

function integerOption(value, fallback, label, minimum, maximum) {
  if (value === undefined) return fallback
  if (!/^\d+$/u.test(value))
    throw new BenchmarkFailure('INVALID_ARGUMENT', `${label} must be an integer`)
  const parsedValue = Number(value)
  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new BenchmarkFailure(
      'INVALID_ARGUMENT',
      `${label} must be from ${String(minimum)} through ${String(maximum)}`,
    )
  }
  return parsedValue
}

function gitValue(args) {
  try {
    return execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unavailable'
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolveValue, rejectValue) => {
    const timer = setTimeout(
      () => rejectValue(new BenchmarkFailure('TIMEOUT', message)),
      milliseconds,
    )
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolveValue(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectValue(error)
      },
    )
  })
}

function elapsed(started) {
  return Math.max(0, Math.round(performance.now() - started))
}

function boundedText(value, label) {
  if (Buffer.byteLength(value, 'utf8') > MAX_RESULT_BYTES) {
    throw new BenchmarkFailure('RESULT_TOO_LARGE', `${label} exceeded the benchmark bound`)
  }
  return value
}

function stableFailureCode(error) {
  if (
    error instanceof BenchmarkFailure &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,64}$/u.test(error.code)
  ) {
    return error.code
  }
  const message = error instanceof Error ? error.message : ''
  if (/authenticat|not logged in|login required|oauth|\b401\b/iu.test(message)) {
    return 'CLAUDE_AUTH_REQUIRED'
  }
  if (/abort|cancel/iu.test(message)) return 'ABORTED'
  if (/timeout|timed out/iu.test(message)) return 'TIMEOUT'
  return 'UNEXPECTED'
}

function processRows() {
  if (process.platform === 'win32') return []
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .flatMap((line) => {
        const fields = line.trim().split(/\s+/u)
        const pid = Number(fields[0])
        const ppid = Number(fields[1])
        return Number.isInteger(pid) && Number.isInteger(ppid) ? [{ pid, ppid }] : []
      })
  } catch {
    return []
  }
}

function descendantPids(rootPid) {
  const rows = processRows()
  const descendants = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if ((row.ppid === rootPid || descendants.has(row.ppid)) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return descendants
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function leakedDescendants(baseline, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let leaked = []
  do {
    leaked = [...descendantPids(process.pid)].filter(
      (pid) => !baseline.has(pid) && processAlive(pid),
    )
    if (leaked.length === 0) return []
    await delay(50)
  } while (Date.now() < deadline)
  return leaked
}

async function terminateOwnedPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // The exact benchmark-owned child may exit between the probe and signal.
    }
  }
  await delay(250)
  for (const pid of pids.filter(processAlive)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The exact benchmark-owned child may exit between the probe and signal.
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function redPng() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 8
  header[9] = 2
  const scanlines = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const IMAGE_BYTES = redPng()
const IMAGE_BASE64 = IMAGE_BYTES.toString('base64')
const IMAGE_REF = Object.freeze({
  attachmentId: `sha256:${createHash('sha256').update(IMAGE_BYTES).digest('hex')}`,
  mediaType: 'image/png',
  bytes: IMAGE_BYTES.length,
  width: 2,
  height: 2,
})

class BenchmarkAttachments extends AttachmentStore {
  imageLimits = {
    maxImageBytes: 8 * 1_024 * 1_024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 20 * 1_024 * 1_024,
    maxImagePixels: 64_000_000,
    maxImageDimension: 8_000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }

  validateImage(input) {
    if (!Buffer.from(input.data).equals(IMAGE_BYTES)) {
      return Promise.reject(new BenchmarkFailure('IMAGE_MISMATCH', 'benchmark image bytes changed'))
    }
    return Promise.resolve()
  }

  saveImage(input) {
    return this.validateImage(input).then(() => IMAGE_REF)
  }

  readImage(ref) {
    if (String(ref.attachmentId) !== IMAGE_REF.attachmentId) {
      return Promise.reject(new BenchmarkFailure('IMAGE_MISMATCH', 'benchmark image ref changed'))
    }
    return Promise.resolve({ ref: IMAGE_REF, data: IMAGE_BYTES })
  }

  readImageRequest(ref) {
    return this.readImage(ref).then(() => ({
      variantId: `variant:${IMAGE_REF.attachmentId}`,
      attachment: IMAGE_REF,
      data: IMAGE_BYTES,
      mediaType: 'image/png',
      bytes: IMAGE_BYTES.length,
      width: 2,
      height: 2,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }))
  }
}

function writeFixture(workspace) {
  mkdirSync(join(workspace, 'src'), { recursive: true })
  const files = {
    'package.json': `${JSON.stringify({ name: 'benchmark-fixture', main: 'src/app.js' }, undefined, 2)}\n`,
    'src/app.js': "import { total } from './math.js'\nexport const answer = total(20, 21)\n",
    'src/math.js':
      "import { OFFSET } from './constants.js'\nexport const total = (a, b) => a + b + OFFSET\n",
    'src/constants.js': 'export const OFFSET = 1\n',
    'src/needle.js': 'export const marker = "NEEDLE"\n',
    'notes.txt': 'fixture-note-42\n',
    'editable.txt': 'draft\n',
    'protected.txt': 'KEEP\n',
    'parallel-a.txt': 'PARALLEL_A\n',
    'parallel-b.txt': 'PARALLEL_B\n',
  }
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(workspace, path), content, 'utf8')
  }
}

function safeFixturePath(workspace, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new BenchmarkFailure('TOOL_ARGUMENT_INVALID', 'fixture path must be a non-empty string')
  }
  const target = resolve(workspace, value)
  const prefix = `${resolve(workspace)}${sep}`
  if (target !== resolve(workspace) && !target.startsWith(prefix)) {
    throw new BenchmarkFailure('TOOL_POLICY_DENIED', 'fixture path escaped the workspace')
  }
  return target
}

function textFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? textFiles(path) : entry.isFile() ? [path] : []
  })
}

const TOOL_SCHEMAS = Object.freeze({
  read_file: {
    name: 'read_file',
    description: 'Read one UTF-8 file inside the synthetic benchmark workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  search_text: {
    name: 'search_text',
    description: 'Search UTF-8 files inside a synthetic benchmark directory.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' } },
      required: ['query', 'path'],
      additionalProperties: false,
    },
  },
  safe_shell: {
    name: 'safe_shell',
    description:
      'Run the single allowlisted synthetic command status; every other command is denied.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace exact text in one synthetic benchmark file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },
  wait_for_cancel: {
    name: 'wait_for_cancel',
    description: 'Wait until the caller cancels this synthetic operation.',
    parameters: {
      type: 'object',
      properties: { milliseconds: { type: 'integer', minimum: 1, maximum: 60_000 } },
      required: ['milliseconds'],
      additionalProperties: false,
    },
  },
  image_fixture: {
    name: 'image_fixture',
    description: 'Return one synthetic red PNG image.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
})

class FixtureTools {
  calls = []
  policyViolation = false
  onCallStart

  constructor(workspace, onCallStart) {
    this.workspace = workspace
    this.onCallStart = onCallStart
  }

  async execute(name, rawArguments, id, signal) {
    const call = {
      id: typeof id === 'string' && id.length > 0 ? id : `missing-${randomUUID()}`,
      hadProviderId: typeof id === 'string' && id.length > 0,
      name,
      status: 'running',
      isError: false,
      startedAt: performance.now(),
    }
    this.calls.push(call)
    this.onCallStart?.(call)
    try {
      if (signal?.aborted === true) throw signal.reason
      const args =
        rawArguments !== null && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
          ? rawArguments
          : {}
      if (name === 'read_file') {
        const path = safeFixturePath(this.workspace, args.path)
        return this.#success(call, { kind: 'text', text: readFileSync(path, 'utf8') })
      }
      if (name === 'search_text') {
        if (typeof args.query !== 'string' || args.query.length === 0) {
          throw new BenchmarkFailure('TOOL_ARGUMENT_INVALID', 'search query is missing')
        }
        const root = safeFixturePath(this.workspace, args.path)
        const matches = textFiles(root).flatMap((path) =>
          readFileSync(path, 'utf8')
            .split('\n')
            .flatMap((line, index) =>
              line.includes(args.query)
                ? [`${relative(this.workspace, path)}:${String(index + 1)}:${line}`]
                : [],
            ),
        )
        return this.#success(call, { kind: 'text', text: `${matches.join('\n')}\n` })
      }
      if (name === 'safe_shell') {
        if (args.command !== 'status') {
          return this.#error(call, 'TOOL_POLICY_DENIED', 'command denied by benchmark policy')
        }
        const text = execFileSync(process.execPath, ['-e', 'process.stdout.write("STATUS_OK")'], {
          cwd: this.workspace,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        return this.#success(call, { kind: 'text', text })
      }
      if (name === 'edit_file') {
        if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
          throw new BenchmarkFailure('TOOL_ARGUMENT_INVALID', 'edit text is missing')
        }
        const path = safeFixturePath(this.workspace, args.path)
        const before = readFileSync(path, 'utf8')
        if (!before.includes(args.oldText)) {
          return this.#error(call, 'EDIT_MISMATCH', 'old text was not found')
        }
        writeFileSync(path, before.replace(args.oldText, args.newText), 'utf8')
        return this.#success(call, { kind: 'text', text: 'EDIT_OK' })
      }
      if (name === 'wait_for_cancel') {
        const milliseconds = args.milliseconds
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) {
          throw new BenchmarkFailure('TOOL_ARGUMENT_INVALID', 'wait duration is invalid')
        }
        await new Promise((resolveWait, rejectWait) => {
          const timer = setTimeout(resolveWait, milliseconds)
          const onAbort = () => {
            clearTimeout(timer)
            rejectWait(signal?.reason ?? new Error('cancelled'))
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
        return this.#success(call, { kind: 'text', text: 'WAIT_FINISHED' })
      }
      if (name === 'image_fixture') {
        return this.#success(call, { kind: 'image' })
      }
      this.policyViolation = true
      return this.#error(call, 'UNKNOWN_TOOL', 'unknown benchmark tool')
    } catch (error) {
      if (
        signal?.aborted === true ||
        /abort|cancel/iu.test(error instanceof Error ? error.message : '')
      ) {
        call.status = 'aborted'
        call.isError = true
        return { ok: false, code: 'ABORTED', text: 'benchmark tool cancelled' }
      }
      if (error?.code === 'ENOENT')
        return this.#error(call, 'PATH_NOT_FOUND', 'fixture path missing')
      return this.#error(call, stableFailureCode(error), 'benchmark tool failed')
    }
  }

  #success(call, result) {
    call.status = 'success'
    return { ok: true, ...result }
  }

  #error(call, code, text) {
    call.status = 'error'
    call.isError = true
    return { ok: false, code, text }
  }
}

function mcpCatalog(names) {
  return names.map((name) => {
    const tool = TOOL_SCHEMAS[name]
    if (tool === undefined) {
      throw new BenchmarkFailure('SCENARIO_INVALID', `unknown benchmark tool ${String(name)}`)
    }
    const parsedTool = McpToolSchema.safeParse({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      _meta: { [MCP_ALWAYS_LOAD_META]: true },
    })
    if (!parsedTool.success) {
      throw new BenchmarkFailure('SCENARIO_INVALID', `invalid benchmark tool ${String(name)}`)
    }
    return parsedTool.data
  })
}

class DirectToolServer {
  instance = new McpServer(
    { name: 'dsh-claude-benchmark', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  config = Object.freeze({ type: 'sdk', name: 'benchmark', instance: this.instance })

  constructor(names, executor) {
    this.names = new Set(names)
    this.catalog = mcpCatalog(names)
    this.executor = executor
    this.instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.catalog],
    }))
    this.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name
      if (!this.names.has(name)) {
        this.executor.policyViolation = true
        return { content: [{ type: 'text', text: 'unknown benchmark tool' }], isError: true }
      }
      const id = request.params._meta?.['claudecode/toolUseId']
      const result = await this.executor.execute(
        name,
        request.params.arguments ?? {},
        typeof id === 'string' ? id : undefined,
        extra.signal,
      )
      if (result.kind === 'image') {
        return { content: [{ type: 'image', mimeType: 'image/png', data: IMAGE_BASE64 }] }
      }
      return {
        content: [{ type: 'text', text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      }
    })
  }

  async close() {
    if (this.instance.isConnected()) await this.instance.close()
  }
}

function sdkUserMessage(prompt, withImage = false) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...(withImage
          ? [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: IMAGE_BASE64 },
              },
            ]
          : []),
      ],
    },
    parent_tool_use_id: null,
    shouldQuery: true,
  }
}

async function* oneSdkMessage(message) {
  yield message
}

function sdkUsage(result) {
  if (result === undefined || result.modelUsage === undefined) return undefined
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
  }
  for (const entry of Object.values(result.modelUsage)) {
    usage.inputTokens += entry.inputTokens ?? 0
    usage.outputTokens += entry.outputTokens ?? 0
    usage.cacheReadTokens += entry.cacheReadInputTokens ?? 0
    usage.cacheWriteTokens += entry.cacheCreationInputTokens ?? 0
    usage.estimatedCostUsd += entry.costUSD ?? 0
  }
  const reasoning = result.usage?.output_tokens_details?.thinking_tokens
  if (typeof reasoning === 'number' && Number.isSafeInteger(reasoning) && reasoning >= 0) {
    usage.reasoningTokens = reasoning
  }
  if (
    typeof result.total_cost_usd === 'number' &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0
  ) {
    usage.estimatedCostUsd = result.total_cost_usd
  }
  return usage
}

function addUsage(left, right) {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    estimatedCostUsd: (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0),
  }
}

function newStreamState() {
  return {
    text: '',
    finalText: '',
    result: undefined,
    firstTokenMs: undefined,
    firstToolRequestMs: undefined,
    textDeltaCount: 0,
    reasoningDeltaCount: 0,
    blockStarts: 0,
    blockStops: 0,
    toolStarts: 0,
    assistantBlocks: 0,
    sessionId: undefined,
    lastAssistantUuid: undefined,
  }
}

function acceptSdkMessage(state, message, started) {
  if (typeof message.session_id === 'string') state.sessionId = message.session_id
  if (message.type === 'stream_event') {
    const event = message.event
    if (event.type === 'content_block_start') {
      state.blockStarts += 1
      if (event.content_block.type === 'tool_use') {
        state.toolStarts += 1
        if (state.firstToolRequestMs === undefined) state.firstToolRequestMs = elapsed(started)
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        if (state.firstTokenMs === undefined) state.firstTokenMs = elapsed(started)
        state.text += event.delta.text
        state.textDeltaCount += 1
      } else if (event.delta.type === 'thinking_delta') {
        if (state.firstTokenMs === undefined) state.firstTokenMs = elapsed(started)
        state.reasoningDeltaCount += 1
      }
    } else if (event.type === 'content_block_stop') {
      state.blockStops += 1
    }
  } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
    state.assistantBlocks += message.message.content.length
    state.lastAssistantUuid = message.uuid
  } else if (message.type === 'result') {
    state.result = message
    state.finalText = message.subtype === 'success' ? message.result : ''
  }
  state.text = boundedText(state.text, 'direct streamed text')
  state.finalText = boundedText(state.finalText, 'direct final text')
}

async function readSdkTurn(iterator, started, timeoutMs) {
  const state = newStreamState()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const next = await withTimeout(iterator.next(), remaining, 'direct SDK turn timed out')
    if (next.done) {
      throw new BenchmarkFailure('SDK_STREAM_ENDED', 'direct SDK stream ended before a result')
    }
    acceptSdkMessage(state, next.value, started)
    if (state.result !== undefined) return state
  }
  throw new BenchmarkFailure('TIMEOUT', 'direct SDK turn timed out')
}

function directOptions(config, server, abortController, persistSession, extras = {}) {
  return {
    abortController,
    allowedTools: ['mcp__benchmark__*'],
    cwd: config.workspace,
    effort: config.effort,
    env: sdkEnvironment([]),
    hooks: {},
    includePartialMessages: true,
    managedSettings: { disableAllHooks: true },
    mcpServers: { benchmark: server.config },
    model: config.model,
    pathToClaudeCodeExecutable: config.claudePath,
    permissionMode: 'dontAsk',
    persistSession,
    plugins: [],
    settings: { disableAllHooks: true },
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    systemPrompt: config.systemPrompt,
    tools: [],
    ...extras,
  }
}

function dshUsageFromReplay(finish) {
  const replay = finish?.replayState?.response
  const usage = replay?.usage
  if (
    usage === null ||
    typeof usage !== 'object' ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    !Number.isSafeInteger(usage.cacheReadTokens) ||
    !Number.isSafeInteger(usage.cacheWriteTokens)
  ) {
    return undefined
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    ...(Number.isSafeInteger(usage.reasoningTokens)
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
    ...(typeof usage.queryCostUsd === 'number' && Number.isFinite(usage.queryCostUsd)
      ? { estimatedCostUsd: usage.queryCostUsd }
      : {}),
  }
}

function addDshTokenDelta(total, delta) {
  total.inputTokens += delta.inputTokens ?? 0
  total.outputTokens += delta.outputTokens ?? 0
  total.cacheReadTokens += delta.cacheReadTokens ?? 0
  total.cacheWriteTokens += delta.cacheWriteTokens ?? 0
  total.reasoningTokens += delta.reasoningTokens ?? 0
}

async function collectDshStep(iterable, started, timeoutMs) {
  const state = {
    blocks: new Map(),
    starts: new Set(),
    finish: undefined,
    firstTokenMs: undefined,
    firstToolRequestMs: undefined,
    textDeltaCount: 0,
    reasoningDeltaCount: 0,
    toolStarts: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
  }
  const iterator = iterable[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const next = await withTimeout(iterator.next(), remaining, 'DSH stream step timed out')
    if (next.done) break
    const chunk = next.value
    if (chunk.type === 'block-start') {
      state.starts.add(chunk.index)
      if (chunk.blockType === 'tool-call') {
        state.toolStarts += 1
        if (state.firstToolRequestMs === undefined) state.firstToolRequestMs = elapsed(started)
      }
    } else if (chunk.type === 'text-delta') {
      if (state.firstTokenMs === undefined) state.firstTokenMs = elapsed(started)
      state.textDeltaCount += 1
    } else if (chunk.type === 'reasoning-delta') {
      if (state.firstTokenMs === undefined) state.firstTokenMs = elapsed(started)
      state.reasoningDeltaCount += 1
    } else if (chunk.type === 'block-end') {
      if (state.blocks.has(chunk.index)) {
        throw new BenchmarkFailure('DUPLICATE_BLOCK', 'DSH emitted a duplicate block end')
      }
      state.blocks.set(chunk.index, chunk.block)
    } else if (chunk.type === 'usage') {
      addDshTokenDelta(state.usage, chunk.usage)
    } else if (chunk.type === 'finish') {
      if (state.finish !== undefined) {
        throw new BenchmarkFailure('DUPLICATE_FINISH', 'DSH emitted a duplicate finish')
      }
      state.finish = chunk
    }
  }
  if (state.finish === undefined) {
    throw new BenchmarkFailure('DSH_STREAM_ENDED', 'DSH stream ended before a finish')
  }
  const blocks = [...state.blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block)
  const text = boundedText(
    blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    'DSH final text',
  )
  return {
    ...state,
    blocks,
    text,
    duplicateBlockCount: 0,
    missingBlockCount: [...state.starts].filter((index) => !state.blocks.has(index)).length,
  }
}

function expectedText(expected) {
  if (expected.kind === 'exact') return expected.value
  if (expected.kind === 'json') return JSON.stringify(expected.value)
  if (expected.kind === 'cancelled') return ''
  throw new BenchmarkFailure('SCENARIO_INVALID', 'scenario has an unsupported expected result')
}

function normalizeOutput(text, expected) {
  const trimmed = text.trim()
  if (expected.kind !== 'json') return trimmed
  try {
    return JSON.stringify(JSON.parse(trimmed))
  } catch {
    return trimmed
  }
}

function uniqueToolIds(calls) {
  const ids = calls.map((call) => call.id)
  return calls.every((call) => call.hadProviderId) && new Set(ids).size === ids.length
}

function checkWorld(workspace, checks = []) {
  return checks.every((entry) => {
    const path = safeFixturePath(workspace, entry.path)
    return (
      existsSync(path) && statSync(path).isFile() && readFileSync(path, 'utf8') === entry.equals
    )
  })
}

function gradeScenario(scenario, output, executor, workspace, cancelled = false) {
  const checks = []
  const failedChecks = []
  const check = (id, pass) => {
    checks.push(id)
    if (!pass) failedChecks.push(id)
  }
  const normalized = normalizeOutput(output, scenario.expected)
  if (scenario.expected.kind === 'cancelled') check('cancelled', cancelled)
  else check('output', normalized === expectedText(scenario.expected))
  const names = executor.calls.map((call) => call.name)
  for (const name of scenario.requiredCalls ?? []) check(`tool:${name}`, names.includes(name))
  if (scenario.minimumCalls !== undefined) {
    check('minimum-tool-calls', executor.calls.length >= scenario.minimumCalls)
  }
  if (scenario.requireToolError === true) {
    check(
      'tool-error-observed',
      executor.calls.some((call) => call.isError),
    )
  }
  check('world-state', checkWorld(workspace, scenario.worldChecks))
  check('forbidden-terminal-marker', !output.includes('CANCELLATION_SHOULD_NOT_FINISH'))
  return {
    normalized,
    correctness: {
      pass: failedChecks.length === 0,
      checks,
      failedChecks,
    },
  }
}

function toolSchemas(scenario) {
  return (scenario.tools ?? []).map((name) => {
    const schema = TOOL_SCHEMAS[name]
    if (schema === undefined) {
      throw new BenchmarkFailure('SCENARIO_INVALID', `unknown tool ${String(name)}`)
    }
    return schema
  })
}

function dshUserMessage(prompt, withImage = false) {
  return createUserMessage({
    content: [
      { type: 'text', text: prompt },
      ...(withImage ? [{ type: 'image', attachment: IMAGE_REF }] : []),
    ],
    source: { kind: 'user' },
  })
}

function dshAssistantMessage(step, model = 'default') {
  return {
    id: randomUUID(),
    role: 'assistant',
    content: step.blocks,
    source: {
      kind: 'model',
      provider: 'claude-code',
      model,
      ...(step.finish.replayState === undefined ? {} : { replayState: step.finish.replayState }),
    },
  }
}

function dshToolResultMessage(call, result) {
  const content =
    result.kind === 'image'
      ? [{ type: 'image', attachment: IMAGE_REF }]
      : [{ type: 'text', text: result.text }]
  return createToolResultMessage({ callId: call.id, content, isError: !result.ok })
}

async function createDshHarness(config) {
  const ctx = new Context()
  const fibers = []
  try {
    fibers.push(await ctx.plugin(LlmRuntime))
    fibers.push(await ctx.plugin(LocalSubprocessRuntime))
    fibers.push(await ctx.plugin(BenchmarkAttachments))
    fibers.push(
      await ctx.plugin(claudePlugin, {
        claudeCommand: config.claudePath,
        defaultModel: config.model,
        executablePolicy: 'host-only',
      }),
    )
    return {
      ctx,
      async close() {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      },
    }
  } catch (error) {
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => undefined)
    throw error
  }
}

function dshRequest(config, scenario, messages, sessionId, signal) {
  return {
    provider: 'claude-code',
    model: 'default',
    reasoningEffort: config.effort,
    messages,
    sessionId,
    system: config.systemPrompt,
    tools: toolSchemas(scenario),
    ...(signal === undefined ? {} : { signal }),
  }
}

async function executeDshToolBoundary(step, executor, signal) {
  const calls = step.blocks.filter((block) => block.type === 'tool-call')
  const results = await Promise.all(
    calls.map(async (call) => {
      let args
      try {
        args = JSON.parse(call.arguments)
      } catch {
        args = {}
      }
      const result = await executor.execute(call.name, args, String(call.id), signal)
      return { call, result }
    }),
  )
  return results
}

async function runDshSingle(config, scenario, executor, abortController) {
  const harness = await createDshHarness(config)
  const messages = [dshUserMessage(scenario.prompt, scenario.inputImage === true)]
  const sessionId = randomUUID()
  const aggregate = {
    textDeltaCount: 0,
    reasoningDeltaCount: 0,
    toolStarts: 0,
    duplicateBlockCount: 0,
    missingBlockCount: 0,
    firstTokenMs: undefined,
    firstToolRequestMs: undefined,
    usage: undefined,
  }
  let output = ''
  let finish
  let cancelled = false
  let cancellationMs
  const started = performance.now()
  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const step = await collectDshStep(
        harness.ctx.llm.stream(
          dshRequest(config, scenario, messages, sessionId, abortController.signal),
        ),
        started,
        config.timeoutMs,
      )
      aggregate.textDeltaCount += step.textDeltaCount
      aggregate.reasoningDeltaCount += step.reasoningDeltaCount
      aggregate.toolStarts += step.toolStarts
      aggregate.duplicateBlockCount += step.duplicateBlockCount
      aggregate.missingBlockCount += step.missingBlockCount
      aggregate.firstTokenMs ??= step.firstTokenMs
      aggregate.firstToolRequestMs ??= step.firstToolRequestMs
      finish = step.finish
      const reason = step.finish.reason.kind
      if (reason === 'tool-calls') {
        messages.push(dshAssistantMessage(step))
        if (scenario.mode === 'cancel') {
          const toolController = new AbortController()
          const cancellationStarted = performance.now()
          const timer = setTimeout(() => {
            cancellationMs = elapsed(cancellationStarted)
            toolController.abort(new Error('benchmark cancellation'))
          }, scenario.abortAfterMs)
          try {
            await executeDshToolBoundary(step, executor, toolController.signal)
          } finally {
            clearTimeout(timer)
          }
          cancelled = executor.calls.some((call) => call.status === 'aborted')
          break
        }
        const results = await executeDshToolBoundary(step, executor, abortController.signal)
        for (const { call, result } of results) {
          messages.push(dshToolResultMessage(call, result))
        }
        continue
      }
      if (reason === 'stop' || reason === 'max-tokens') {
        output = step.text
        messages.push(dshAssistantMessage(step))
        aggregate.usage = dshUsageFromReplay(step.finish)
        break
      }
      if (reason === 'aborted') {
        cancelled = true
        break
      }
      throw new BenchmarkFailure('DSH_TERMINAL_ERROR', 'DSH returned a terminal error')
    }
    if (finish === undefined) {
      throw new BenchmarkFailure('MAX_ITERATIONS', 'DSH exceeded the tool-step bound')
    }
    return {
      output,
      cancelled,
      cancellationMs,
      durationMs: elapsed(started),
      ...aggregate,
      finish,
      messages,
    }
  } finally {
    await harness.close()
  }
}

async function runDirectSingle(config, scenario, executor, abortController) {
  let query
  let execution
  let runError
  const server = new DirectToolServer(scenario.tools ?? [], executor)
  const started = performance.now()
  let cancellationStarted
  let cancellationMs
  if (scenario.mode === 'cancel') {
    executor.onCallStart = () => {
      if (cancellationStarted !== undefined) return
      cancellationStarted = performance.now()
      setTimeout(() => {
        cancellationMs = elapsed(cancellationStarted)
        abortController.abort(new Error('benchmark cancellation'))
        try {
          query?.close()
        } catch {
          // The abort signal already owns cancellation; close only forces prompt teardown.
        }
      }, scenario.abortAfterMs).unref()
    }
  }
  try {
    query = sdkQuery({
      prompt: oneSdkMessage(sdkUserMessage(scenario.prompt, scenario.inputImage === true)),
      options: directOptions(config, server, abortController, false),
    })
    const iterator = query[Symbol.asyncIterator]()
    let turn
    try {
      turn = await readSdkTurn(iterator, started, config.timeoutMs)
    } catch (error) {
      if (scenario.mode !== 'cancel' || !abortController.signal.aborted) throw error
      turn = newStreamState()
    }
    const cancelled = scenario.mode === 'cancel' && abortController.signal.aborted
    execution = {
      output: turn.finalText,
      cancelled,
      cancellationMs,
      durationMs: elapsed(started),
      firstTokenMs: turn.firstTokenMs,
      firstToolRequestMs: turn.firstToolRequestMs,
      textDeltaCount: turn.textDeltaCount,
      reasoningDeltaCount: turn.reasoningDeltaCount,
      toolStarts: turn.toolStarts,
      duplicateBlockCount: 0,
      missingBlockCount: Math.max(0, turn.blockStarts - turn.blockStops),
      usage: sdkUsage(turn.result),
      result: turn.result,
    }
  } catch (error) {
    runError = error
  }
  let closeError
  try {
    query?.close()
  } catch (error) {
    closeError = error
  }
  await server.close().catch(() => undefined)
  if (runError !== undefined) throw runError
  if (closeError !== undefined && (scenario.mode !== 'cancel' || !abortController.signal.aborted)) {
    throw closeError
  }
  if (execution === undefined) {
    throw new BenchmarkFailure('DIRECT_RESULT_MISSING', 'direct benchmark result is missing')
  }
  return execution
}

function mergeStepMetrics(target, source) {
  target.durationMs += source.durationMs
  target.firstTokenMs ??= source.firstTokenMs
  target.firstToolRequestMs ??= source.firstToolRequestMs
  target.textDeltaCount += source.textDeltaCount
  target.reasoningDeltaCount += source.reasoningDeltaCount
  target.toolStarts += source.toolStarts
  target.duplicateBlockCount += source.duplicateBlockCount
  target.missingBlockCount += source.missingBlockCount
}

function newAggregateMetrics() {
  return {
    durationMs: 0,
    firstTokenMs: undefined,
    firstToolRequestMs: undefined,
    textDeltaCount: 0,
    reasoningDeltaCount: 0,
    toolStarts: 0,
    duplicateBlockCount: 0,
    missingBlockCount: 0,
  }
}

async function runDirectSession(config, scenario, executor, abortController) {
  const outputs = []
  const metrics = newAggregateMetrics()
  let usage
  let actualSessionId
  let firstQuery
  let secondQuery
  const firstServer = new DirectToolServer([], executor)
  const queue = new MessageQueue()
  try {
    firstQuery = sdkQuery({
      prompt: queue,
      options: directOptions(config, firstServer, abortController, true),
    })
    const iterator = firstQuery[Symbol.asyncIterator]()
    for (const turn of scenario.turns.slice(0, 2)) {
      const started = performance.now()
      queue.push(sdkUserMessage(turn.prompt))
      const result = await readSdkTurn(iterator, started, config.timeoutMs)
      actualSessionId = result.sessionId ?? actualSessionId
      outputs.push(result.finalText)
      mergeStepMetrics(metrics, {
        durationMs: elapsed(started),
        firstTokenMs: result.firstTokenMs,
        firstToolRequestMs: result.firstToolRequestMs,
        textDeltaCount: result.textDeltaCount,
        reasoningDeltaCount: result.reasoningDeltaCount,
        toolStarts: result.toolStarts,
        duplicateBlockCount: 0,
        missingBlockCount: Math.max(0, result.blockStarts - result.blockStops),
      })
      usage = sdkUsage(result.result)
    }
    if (actualSessionId === undefined) {
      throw new BenchmarkFailure('SESSION_ID_MISSING', 'direct SDK emitted no resumable session ID')
    }
    queue.close()
    firstQuery.close()
    firstQuery = undefined
    await firstServer.close()
    const third = scenario.turns[2]
    if (third === undefined || third.restartBefore !== true) {
      throw new BenchmarkFailure('SCENARIO_INVALID', 'session scenario is missing restart turn')
    }
    const secondServer = new DirectToolServer([], executor)
    const started = performance.now()
    try {
      secondQuery = sdkQuery({
        prompt: oneSdkMessage(sdkUserMessage(third.prompt)),
        options: directOptions(config, secondServer, abortController, true, {
          resume: actualSessionId,
          forkSession: true,
        }),
      })
      const result = await readSdkTurn(
        secondQuery[Symbol.asyncIterator](),
        started,
        config.timeoutMs,
      )
      outputs.push(result.finalText)
      mergeStepMetrics(metrics, {
        durationMs: elapsed(started),
        firstTokenMs: result.firstTokenMs,
        firstToolRequestMs: result.firstToolRequestMs,
        textDeltaCount: result.textDeltaCount,
        reasoningDeltaCount: result.reasoningDeltaCount,
        toolStarts: result.toolStarts,
        duplicateBlockCount: 0,
        missingBlockCount: Math.max(0, result.blockStarts - result.blockStops),
      })
      usage = addUsage(usage, sdkUsage(result.result))
    } finally {
      secondQuery?.close()
      secondQuery = undefined
      await secondServer.close().catch(() => undefined)
    }
    return { outputs, usage, ...metrics, cancelled: false }
  } finally {
    queue.close()
    firstQuery?.close()
    secondQuery?.close()
    await firstServer.close().catch(() => undefined)
  }
}

async function runDshSession(config, scenario, executor, abortController) {
  const outputs = []
  const metrics = newAggregateMetrics()
  const messages = []
  const sessionId = randomUUID()
  let usageBeforeRestart
  let harness = await createDshHarness(config)
  try {
    for (const turn of scenario.turns.slice(0, 2)) {
      messages.push(dshUserMessage(turn.prompt))
      const started = performance.now()
      const step = await collectDshStep(
        harness.ctx.llm.stream(
          dshRequest(config, scenario, messages, sessionId, abortController.signal),
        ),
        started,
        config.timeoutMs,
      )
      if (step.finish.reason.kind !== 'stop') {
        throw new BenchmarkFailure('SESSION_TURN_FAILED', 'DSH session turn did not stop normally')
      }
      outputs.push(step.text)
      messages.push(dshAssistantMessage(step))
      mergeStepMetrics(metrics, {
        durationMs: elapsed(started),
        firstTokenMs: step.firstTokenMs,
        firstToolRequestMs: step.firstToolRequestMs,
        textDeltaCount: step.textDeltaCount,
        reasoningDeltaCount: step.reasoningDeltaCount,
        toolStarts: step.toolStarts,
        duplicateBlockCount: step.duplicateBlockCount,
        missingBlockCount: step.missingBlockCount,
      })
      usageBeforeRestart = dshUsageFromReplay(step.finish)
    }
    await harness.close()
    harness = undefined
    const third = scenario.turns[2]
    if (third === undefined || third.restartBefore !== true) {
      throw new BenchmarkFailure('SCENARIO_INVALID', 'session scenario is missing restart turn')
    }
    messages.push(dshUserMessage(third.prompt))
    harness = await createDshHarness(config)
    const started = performance.now()
    const step = await collectDshStep(
      harness.ctx.llm.stream(
        dshRequest(config, scenario, messages, sessionId, abortController.signal),
      ),
      started,
      config.timeoutMs,
    )
    if (step.finish.reason.kind !== 'stop') {
      throw new BenchmarkFailure('SESSION_RESTART_FAILED', 'DSH restart turn did not stop normally')
    }
    outputs.push(step.text)
    messages.push(dshAssistantMessage(step))
    mergeStepMetrics(metrics, {
      durationMs: elapsed(started),
      firstTokenMs: step.firstTokenMs,
      firstToolRequestMs: step.firstToolRequestMs,
      textDeltaCount: step.textDeltaCount,
      reasoningDeltaCount: step.reasoningDeltaCount,
      toolStarts: step.toolStarts,
      duplicateBlockCount: step.duplicateBlockCount,
      missingBlockCount: step.missingBlockCount,
    })
    const usage = addUsage(usageBeforeRestart, dshUsageFromReplay(step.finish))
    return { outputs, usage, ...metrics, cancelled: false }
  } finally {
    await harness?.close().catch(() => undefined)
  }
}

function gradeSession(scenario, outputs, executor, workspace) {
  const checks = []
  const failedChecks = []
  const normalized = []
  for (const [index, turn] of scenario.turns.entries()) {
    const output = normalizeOutput(outputs[index] ?? '', turn.expected)
    normalized.push(output)
    const id = `turn-${String(index + 1)}`
    checks.push(id)
    if (output !== expectedText(turn.expected)) failedChecks.push(id)
  }
  checks.push('world-state')
  if (!checkWorld(workspace, scenario.worldChecks)) failedChecks.push('world-state')
  checks.push('no-tools')
  if (executor.calls.length !== 0) failedChecks.push('no-tools')
  return {
    normalized: normalized.join('\n'),
    correctness: { pass: failedChecks.length === 0, checks, failedChecks },
  }
}

function expectedScenarioDigest(scenario) {
  if (scenario.mode === 'session') {
    return digestBenchmarkText(scenario.turns.map((turn) => expectedText(turn.expected)).join('\n'))
  }
  return digestBenchmarkText(expectedText(scenario.expected))
}

function environmentId(config) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commit: config.commit,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        dsh: EXPECTED_DSH_VERSION,
        sdk: sdkManifest.version,
        claudeCode: config.claudeCodeVersion,
        model: config.model,
        effort: config.effort,
      }),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32)
}

function redactionPass(observation, scenario, config) {
  const encoded = JSON.stringify(observation)
  const protectedValues = [
    scenario.prompt,
    ...(scenario.turns ?? []).map((turn) => turn.prompt),
    expectedTextForRedaction(scenario),
    config.workspace,
  ].filter((value) => typeof value === 'string' && value.length > 0)
  const forbiddenFields = [
    'prompt',
    'systemPrompt',
    'toolArguments',
    'toolResults',
    'providerError',
    'environment',
  ]
  return (
    protectedValues.every((value) => !encoded.includes(value)) &&
    forbiddenFields.every((field) => !encoded.includes(`"${field}"`))
  )
}

function expectedTextForRedaction(scenario) {
  return scenario.mode === 'session'
    ? scenario.turns.map((turn) => expectedText(turn.expected)).join('\n')
    : expectedText(scenario.expected)
}

async function runLane(config, scenario, lane, phase, repetition) {
  const baseline = descendantPids(process.pid)
  const laneStarted = performance.now()
  const executor = new FixtureTools(config.workspace)
  const abortController = new AbortController()
  const laneTimer = setTimeout(
    () => abortController.abort(new Error('benchmark lane timeout')),
    config.timeoutMs,
  )
  laneTimer.unref()
  const originalCwd = process.cwd()
  let execution
  let failureCode
  let grade
  let cleanupStarted
  let leaked = []
  try {
    process.chdir(config.workspace)
    if (scenario.mode === 'session') {
      execution =
        lane === 'direct'
          ? await runDirectSession(config, scenario, executor, abortController)
          : await runDshSession(config, scenario, executor, abortController)
      grade = gradeSession(scenario, execution.outputs, executor, config.workspace)
    } else {
      execution =
        lane === 'direct'
          ? await runDirectSingle(config, scenario, executor, abortController)
          : await runDshSingle(config, scenario, executor, abortController)
      grade = gradeScenario(
        scenario,
        execution.output,
        executor,
        config.workspace,
        execution.cancelled,
      )
    }
  } catch (error) {
    failureCode = stableFailureCode(error)
    execution ??= {
      output: '',
      outputs: [],
      cancelled: abortController.signal.aborted && scenario.mode === 'cancel',
      durationMs: elapsed(laneStarted),
      firstTokenMs: undefined,
      firstToolRequestMs: undefined,
      cancellationMs: undefined,
      textDeltaCount: 0,
      reasoningDeltaCount: 0,
      toolStarts: 0,
      duplicateBlockCount: 0,
      missingBlockCount: 0,
      usage: undefined,
    }
    grade = {
      normalized: '',
      correctness: { pass: false, checks: ['terminal'], failedChecks: ['terminal'] },
    }
  } finally {
    clearTimeout(laneTimer)
    process.chdir(originalCwd)
    cleanupStarted = performance.now()
    leaked = await leakedDescendants(baseline)
    await terminateOwnedPids(leaked)
  }
  const cleanupMs = elapsed(cleanupStarted)
  const callIdsValid = uniqueToolIds(executor.calls)
  const callsSettled = executor.calls.every((call) => call.status !== 'running')
  const expectedCalls = execution.cancelled
    ? executor.calls.length === 1 && executor.calls[0]?.status === 'aborted'
    : execution.toolStarts === executor.calls.length
  const output = grade.normalized
  const terminalSuccess = benchmarkTerminalSuccess(failureCode, grade.correctness.pass)
  let observation = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId: config.runId,
    environmentId: config.environmentId,
    scenarioId: scenario.id,
    category: scenario.category,
    core: scenario.core,
    lane,
    phase,
    repetition,
    model: config.model,
    effort: config.effort,
    success: terminalSuccess && leaked.length === 0,
    correctness: grade.correctness,
    output: digestBenchmarkText(output),
    expectedOutput: expectedScenarioDigest(scenario),
    durationMs: execution.durationMs,
    ...(execution.firstTokenMs === undefined ? {} : { firstTokenMs: execution.firstTokenMs }),
    ...(execution.firstToolRequestMs === undefined
      ? {}
      : { firstToolRequestMs: execution.firstToolRequestMs }),
    ...(execution.cancellationMs === undefined
      ? scenario.mode === 'cancel' && executor.calls[0] !== undefined
        ? {
            cancellationMs: Math.max(
              0,
              Math.round(performance.now() - executor.calls[0].startedAt),
            ),
          }
        : {}
      : { cancellationMs: execution.cancellationMs }),
    cleanupMs,
    textDeltaCount: execution.textDeltaCount,
    reasoningDeltaCount: execution.reasoningDeltaCount,
    toolCallCount: executor.calls.length,
    toolResultCount: executor.calls.filter((call) => call.status !== 'running').length,
    duplicateBlockCount: execution.duplicateBlockCount,
    missingBlockCount: execution.missingBlockCount,
    childProcessesLeaked: leaked.length,
    ...(execution.usage === undefined ? {} : { usage: execution.usage }),
    invariants: {
      cleanup: leaked.length === 0,
      toolCorrelation:
        callIdsValid && callsSettled && expectedCalls && execution.missingBlockCount === 0,
      policy: !executor.policyViolation && checkWorld(config.workspace, scenario.worldChecks),
      transcript: benchmarkTranscriptInvariant(
        execution.duplicateBlockCount,
        execution.missingBlockCount,
      ),
      redaction: true,
    },
    ...(failureCode === undefined ? {} : { failureCode }),
  }
  if (!redactionPass(observation, scenario, config)) {
    observation = {
      ...observation,
      success: false,
      invariants: { ...observation.invariants, redaction: false },
      failureCode: 'REDACTION_FAILURE',
    }
  }
  return validateBenchmarkObservation(observation)
}

function validateScenarioFixture(value) {
  if (value?.schemaVersion !== 1 || typeof value.systemPrompt !== 'string') {
    throw new BenchmarkFailure('SCENARIO_INVALID', 'benchmark scenario fixture header is invalid')
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new BenchmarkFailure('SCENARIO_INVALID', 'benchmark scenario fixture is empty')
  }
  const ids = new Set()
  for (const scenario of value.scenarios) {
    if (
      scenario === null ||
      typeof scenario !== 'object' ||
      typeof scenario.id !== 'string' ||
      !/^[a-z][a-z0-9.-]{1,63}$/u.test(scenario.id) ||
      typeof scenario.category !== 'string' ||
      typeof scenario.core !== 'boolean' ||
      !['single', 'session', 'cancel'].includes(scenario.mode)
    ) {
      throw new BenchmarkFailure('SCENARIO_INVALID', 'benchmark scenario metadata is invalid')
    }
    if (ids.has(scenario.id)) {
      throw new BenchmarkFailure('SCENARIO_INVALID', `duplicate scenario ${scenario.id}`)
    }
    ids.add(scenario.id)
    if (scenario.mode === 'session') {
      if (!Array.isArray(scenario.turns) || scenario.turns.length !== 3) {
        throw new BenchmarkFailure('SCENARIO_INVALID', `${scenario.id} must contain three turns`)
      }
    } else if (typeof scenario.prompt !== 'string' || scenario.expected === undefined) {
      throw new BenchmarkFailure(
        'SCENARIO_INVALID',
        `${scenario.id} prompt or expected value is missing`,
      )
    }
    toolSchemas(scenario)
  }
  return value
}

function selectedScenarios(fixture, requested) {
  if (requested === undefined || requested.length === 0) return fixture.scenarios
  const selected = requested.map((id) => fixture.scenarios.find((scenario) => scenario.id === id))
  const missing = requested.filter((_, index) => selected[index] === undefined)
  if (missing.length > 0) {
    throw new BenchmarkFailure('SCENARIO_UNKNOWN', `unknown scenario ${missing.join(', ')}`)
  }
  return selected
}

function sanitizedDoctor(report) {
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    success: report.checks.some(
      (entry) => entry.id === 'generation.live' && entry.status === 'pass',
    ),
    overall: report.overall,
    versions: report.versions,
    checks: report.checks.map((entry) => ({ id: entry.id, status: entry.status })),
  }
}

async function preflight(model, timeoutMs, outputPath) {
  const report = await runDoctor({
    executablePolicy: 'host-only',
    live: 'always',
    model,
    timeoutMs: Math.min(timeoutMs, 120_000),
    cwd: repository,
  })
  const sanitized = sanitizedDoctor(report)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(sanitized, undefined, 2)}\n`, 'utf8')
  return { report, sanitized }
}

function safeReportPath(path) {
  const absolute = resolve(path)
  const repositoryPrefix = `${repository}${sep}`
  if (absolute !== repository && !absolute.startsWith(repositoryPrefix)) {
    throw new BenchmarkFailure(
      'PATH_OUTSIDE_REPOSITORY',
      'benchmark output must stay in the repository',
    )
  }
  return absolute
}

function writeJsonLines(path, observations) {
  mkdirSync(dirname(path), { recursive: true })
  const lines = observations.map((entry) => JSON.stringify(entry))
  writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
}

function reportEnvironment(config, resultsPath, warmups, repetitions) {
  return {
    generatedAt: new Date().toISOString(),
    commit: config.commit,
    branch: config.branch,
    dirty: config.dirty,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dsh: EXPECTED_DSH_VERSION,
    sdk: sdkManifest.version,
    claudeCode: config.claudeCodeVersion,
    model: config.model,
    effort: config.effort,
    warmups,
    repetitions,
    resultsPath: relative(repository, resultsPath),
  }
}

async function runLive(options) {
  const artifactDirectory = join(repository, '.artifacts')
  const preflightPath = join(artifactDirectory, 'benchmark-preflight.json')
  const gate = await preflight(options.model, options.timeoutMs, preflightPath)
  if (!gate.sanitized.success) {
    throw new BenchmarkFailure(
      'CLAUDE_AUTH_REQUIRED',
      'authenticated host-only doctor failed; run `claude auth login` before benchmarking',
    )
  }
  const claudePath = await resolveDoctorExecutable('claude')
  if (claudePath === undefined) {
    throw new BenchmarkFailure('CLAUDE_EXECUTABLE_MISSING', 'host Claude executable is missing')
  }
  const commit = gitValue(['rev-parse', 'HEAD'])
  const branch = gitValue(['branch', '--show-current']) || 'detached'
  const dirty = gitValue(['status', '--porcelain']) !== ''
  if (dirty) {
    throw new BenchmarkFailure(
      'DIRTY_CHECKOUT',
      'benchmark claims require a clean exact plugin checkout',
    )
  }
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/gu, '')
    .slice(0, 14)
  const runId = `run-${timestamp}-${randomUUID().slice(0, 8)}`
  const shortCommit = /^[0-9a-f]{40}$/u.test(commit) ? commit.slice(0, 12) : 'unknown'
  const resultsPath = safeReportPath(
    options.results ?? join(repository, 'reports', 'data', `benchmark-${shortCommit}.jsonl`),
  )
  const reportPath = safeReportPath(
    options.report ??
      join(repository, 'reports', `benchmark-${new Date().toISOString().slice(0, 10)}.md`),
  )
  const runRoot = mkdtempSync(join(tmpdir(), 'dsh-claude-benchmark-'))
  const baseConfig = {
    runId,
    environmentId: '',
    commit,
    branch,
    dirty,
    claudePath,
    claudeCodeVersion: gate.report.versions.runtimeClaudeCode ?? gate.report.versions.sdkClaudeCode,
    model: options.model,
    effort: options.effort,
    systemPrompt: scenarioFixture.systemPrompt,
    timeoutMs: options.timeoutMs,
    workspace: '',
  }
  baseConfig.environmentId = environmentId(baseConfig)
  const observations = []
  try {
    for (const phase of ['warmup', 'measured']) {
      const count = phase === 'warmup' ? options.warmups : options.repetitions
      for (let repetition = 0; repetition < count; repetition += 1) {
        for (const [scenarioIndex, scenario] of options.scenarios.entries()) {
          const order =
            (repetition + scenarioIndex) % 2 === 0 ? ['direct', 'dsh'] : ['dsh', 'direct']
          for (const lane of order) {
            const workspace = join(runRoot, scenario.id, phase, String(repetition), lane)
            mkdirSync(workspace, { recursive: true })
            writeFixture(workspace)
            const config = { ...baseConfig, workspace }
            process.stderr.write(
              `[${phase}] ${scenario.id} ${lane} ${String(repetition + 1)}/${String(count)}\n`,
            )
            const observation = await runLane(config, scenario, lane, phase, repetition)
            observations.push(observation)
            writeJsonLines(resultsPath, observations)
          }
        }
      }
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
  const analysis = analyzeBenchmark(observations)
  const environment = reportEnvironment(
    baseConfig,
    resultsPath,
    options.warmups,
    options.repetitions,
  )
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, renderBenchmarkMarkdown(environment, analysis), 'utf8')
  const p0 = analysis.weaknesses.filter((entry) => entry.severity === 'P0').length
  const failures = observations.filter(
    (entry) => entry.phase === 'measured' && !entry.success,
  ).length
  process.stdout.write(
    `${JSON.stringify(
      {
        success: p0 === 0 && failures === 0,
        runId,
        scenarios: options.scenarios.length,
        observations: observations.length,
        measuredFailures: failures,
        p0,
        p1: analysis.weaknesses.filter((entry) => entry.severity === 'P1').length,
        complete: analysis.complete,
        results: relative(repository, resultsPath),
        report: relative(repository, reportPath),
      },
      undefined,
      2,
    )}\n`,
  )
  if (p0 > 0 || failures > 0) process.exitCode = 1
}

async function main() {
  if (parsed.values.help === true) {
    process.stdout.write(HELP)
    return
  }
  const fixture = validateScenarioFixture(scenarioFixture)
  if (parsed.values.list === true) {
    for (const scenario of fixture.scenarios) {
      process.stdout.write(`${scenario.id}\t${scenario.category}\t${scenario.mode}\n`)
    }
    return
  }
  if (parsed.values.live === true && parsed.values.preflight === true) {
    throw new BenchmarkFailure('INVALID_ARGUMENT', '--live and --preflight are mutually exclusive')
  }
  const model = parsed.values.model ?? 'sonnet'
  const effort = parsed.values.effort ?? 'medium'
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) {
    throw new BenchmarkFailure('INVALID_ARGUMENT', '--model has an invalid shape')
  }
  if (!['low', 'medium', 'high'].includes(effort)) {
    throw new BenchmarkFailure('INVALID_ARGUMENT', '--effort must be low, medium, or high')
  }
  const quick = parsed.values.quick === true
  const warmups = quick ? 0 : integerOption(parsed.values.warmups, 1, '--warmups', 0, 10)
  const repetitions = quick
    ? 1
    : integerOption(parsed.values.repetitions, 5, '--repetitions', 1, 20)
  const timeoutMs = integerOption(
    parsed.values['timeout-ms'],
    DEFAULT_TIMEOUT_MS,
    '--timeout-ms',
    1_000,
    MAX_TIMEOUT_MS,
  )
  const scenarios = selectedScenarios(fixture, parsed.values.scenario)
  if (parsed.values.live === true) {
    await runLive({
      model,
      effort,
      warmups,
      repetitions,
      timeoutMs,
      scenarios,
      results: parsed.values.results,
      report: parsed.values.report,
    })
    return
  }
  const outputPath = safeReportPath(
    parsed.values.results ?? join(repository, '.artifacts', 'benchmark-preflight.json'),
  )
  const gate = await preflight(model, timeoutMs, outputPath)
  process.stdout.write(
    `${JSON.stringify(
      {
        success: gate.sanitized.success,
        mode: 'preflight',
        failureCode: gate.sanitized.success ? undefined : 'CLAUDE_AUTH_REQUIRED',
        report: relative(repository, outputPath),
      },
      undefined,
      2,
    )}\n`,
  )
  if (!gate.sanitized.success) process.exitCode = 2
}

try {
  await main()
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ success: false, failureCode: stableFailureCode(error) })}\n`,
  )
  process.exitCode = 2
}
