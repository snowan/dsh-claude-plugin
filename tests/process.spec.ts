import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import {
  ClaudeProcessFactory,
  CLAUDE_RUNTIME_ENV,
  DshSpawnedProcess,
  filterClaudeEnvironment,
  MAX_CLAUDE_STDERR_BYTES,
  resolveClaudeExecutable,
  sdkEnvironment,
} from '../src/process.js'
import { resolveConfig } from '../src/index.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function handleFixture() {
  const done = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const handle: SubprocessHandle = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    control: undefined,
    collected: {
      stderr: {
        readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
      },
    },
    done: done.promise,
    terminate: vi.fn(),
    waitForExit: vi.fn(() => done.promise.then(() => true)),
  }
  return { done, handle }
}

describe('managed Claude process adapter', () => {
  it('forwards only SDK facts and explicitly allowed safe names', () => {
    expect(
      filterClaudeEnvironment(
        {
          CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
          CLAUDE_AGENT_SDK_VERSION: '0.3.241',
          CLAUDE_AGENT_SDK_CLIENT_APP: 'fixture',
          HTTPS_PROXY: 'https://proxy.invalid',
          PATH: '/unsafe/override',
          HOME: '/Users/fixture',
          USER: 'fixture',
          DSH_WEB_URL: 'http://localhost',
          ANTHROPIC_API_KEY: 'secret',
          SAFE_TOKENIZER_MODE: 'still blocked because name contains token',
        },
        ['HTTPS_PROXY'],
      ),
    ).toEqual({
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '0.3.241',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'fixture',
      HTTPS_PROXY: 'https://proxy.invalid',
      HOME: '/Users/fixture',
      USER: 'fixture',
    })
  })

  it('supplies only non-secret identity/home facts needed by the authenticated CLI', () => {
    const environment = sdkEnvironment([])
    for (const [name, value] of Object.entries(environment)) {
      if (name === 'CLAUDE_AGENT_SDK_CLIENT_APP') continue
      expect(CLAUDE_RUNTIME_ENV.has(name.toUpperCase())).toBe(true)
      expect(value).toBe(process.env[name])
    }
    expect(environment.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('dsh-claude-plugin/0.1.0')
    if (process.env.HOME !== undefined) expect(environment.HOME).toBe(process.env.HOME)
    if (process.env.USER !== undefined) expect(environment.USER).toBe(process.env.USER)
  })

  it('resolves host, fallback, and bundled executable policies', async () => {
    const resolveExecutable = vi.fn(() => Promise.resolve('/opt/claude'))
    const runtime = { resolveExecutable } as unknown as SubprocessRuntime
    await expect(resolveClaudeExecutable(runtime, 'claude', 'host-only')).resolves.toBe(
      '/opt/claude',
    )
    await expect(
      resolveClaudeExecutable(runtime, 'claude', 'bundled-only'),
    ).resolves.toBeUndefined()
    expect(resolveExecutable).toHaveBeenCalledTimes(1)

    resolveExecutable.mockRejectedValueOnce(new Error('missing'))
    await expect(
      resolveClaudeExecutable(runtime, 'claude', 'host-then-bundled'),
    ).resolves.toBeUndefined()
    resolveExecutable.mockRejectedValueOnce(new Error('missing'))
    await expect(resolveClaudeExecutable(runtime, 'claude', 'host-only')).rejects.toMatchObject({
      code: 'CLAUDE_EXECUTABLE_NOT_FOUND',
    })
  })

  it('maps DSH streams, exit state, and tree termination to the SDK facade', async () => {
    const fixture = handleFixture()
    const process = new DshSpawnedProcess(fixture.handle)
    const exited = vi.fn()
    process.on('exit', exited)
    expect(process.kill('SIGTERM')).toBe(true)
    expect(process.kill('SIGTERM')).toBe(false)
    expect(fixture.handle.terminate).toHaveBeenCalledOnce()
    fixture.done.resolve({ exitCode: null, signal: 'SIGTERM' })
    await fixture.handle.done
    await Promise.resolve()
    expect(process.killed).toBe(true)
    expect(process.exitCode).toBeNull()
    expect(process.signalCode).toBe('SIGTERM')
    expect(exited).toHaveBeenCalledWith(null, 'SIGTERM')
  })

  it('uses explicit argv/cwd/stdio/grace and a bounded stderr tail', () => {
    const fixture = handleFixture()
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => fixture.handle)
    const runtime = { spawn } as unknown as SubprocessRuntime
    const factory = new ClaudeProcessFactory(
      runtime,
      resolveConfig({ shutdownGraceMs: 777, passEnv: ['NO_PROXY'] }),
    )
    const controller = new AbortController()
    factory.spawn({
      command: '/opt/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/workspace',
      env: {
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        NO_PROXY: 'localhost',
        DSH_HOME: '/private',
      },
      signal: controller.signal,
    })
    expect(spawn).toHaveBeenCalledWith({
      argv: ['/opt/claude', '--output-format', 'stream-json'],
      cwd: '/workspace',
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: MAX_CLAUDE_STDERR_BYTES },
      },
      graceMs: 777,
      signal: controller.signal,
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', NO_PROXY: 'localhost' },
    })
    fixture.done.resolve({ exitCode: 0, signal: null })
  })

  it('terminates and waits for every tracked process at disposal', async () => {
    const fixture = handleFixture()
    const runtime = { spawn: () => fixture.handle } as unknown as SubprocessRuntime
    const factory = new ClaudeProcessFactory(runtime, resolveConfig())
    factory.spawn({ command: 'claude', args: [], env: {}, signal: new AbortController().signal })
    const disposing = factory.dispose()
    expect(fixture.handle.terminate).toHaveBeenCalledOnce()
    fixture.done.resolve({ exitCode: 0, signal: null })
    await disposing
    expect(fixture.handle.waitForExit).toHaveBeenCalledOnce()
  })

  it('rejects a managed handle without protocol pipes', () => {
    const fixture = handleFixture()
    const broken = { ...fixture.handle, stdin: undefined }
    expect(() => new DshSpawnedProcess(broken)).toThrow(/required stdin\/stdout pipes/)
    expect(fixture.handle.terminate).toHaveBeenCalledOnce()
    fixture.done.resolve({ exitCode: 1, signal: null })
  })

  it('emits normalized spawn errors and preserves aborted executable lookup', async () => {
    const fixture = handleFixture()
    const process = new DshSpawnedProcess(fixture.handle)
    const observed = vi.fn()
    process.on('error', observed)
    fixture.done.reject('non-error failure')
    await expect(fixture.handle.done).rejects.toBe('non-error failure')
    await Promise.resolve()
    expect(observed.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: 'managed Claude process failed to spawn' }),
    )

    const controller = new AbortController()
    controller.abort()
    const failure = new Error('lookup aborted')
    const runtime = {
      resolveExecutable: () => Promise.reject(failure),
    } as unknown as SubprocessRuntime
    await expect(
      resolveClaudeExecutable(runtime, 'claude', 'host-then-bundled', controller.signal),
    ).rejects.toBe(failure)
  })

  it('surfaces process cleanup failures', async () => {
    const fixture = handleFixture()
    fixture.handle.waitForExit = vi.fn(() => Promise.reject(new Error('wait failed')))
    const runtime = { spawn: () => fixture.handle } as unknown as SubprocessRuntime
    const factory = new ClaudeProcessFactory(runtime, resolveConfig())
    factory.spawn({ command: 'claude', args: [], env: {}, signal: new AbortController().signal })
    const disposing = factory.dispose()
    fixture.done.resolve({ exitCode: 0, signal: null })
    await expect(disposing).rejects.toThrow(/cleanup failed/)
  })
})
