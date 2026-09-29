import { describe, expect, it, vi } from 'vitest'
import {
  DshRpcError,
  dshRpc,
  historyAssistantMarkerCount,
  historyHasAssistantMarker,
  historyHasToolResultMarker,
  inspectClaudeCatalog,
  authenticateDshWeb,
  parseDshReadyUrl,
  parseDshWebLaunch,
  stableFailureCode,
  summarizeHistory,
} from '../src/web-e2e.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const models = {
  default: { provider: 'claude-code', model: 'default' },
  routableProviders: ['claude-code'],
  groups: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      models: ['default', 'sonnet', 'opus', 'haiku'].map((id) => ({
        id,
        name: id,
        reasoning: {
          efforts: ['low', 'medium', 'high'].map((effort) => ({ id: effort, name: effort })),
        },
      })),
    },
  ],
  failures: [],
}

const history = {
  records: [
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: { message: { content: [{ type: 'text', text: 'DSH_WEB_TEXT_OK' }] } },
      },
    },
    {
      type: 'event',
      event: {
        type: 'tool/call',
        seq: 2,
        time: 2,
        data: { name: 'bash', arguments: '{"redacted":true}' },
      },
    },
    {
      type: 'event',
      event: {
        type: 'tool/result',
        seq: 3,
        time: 3,
        data: {
          message: { role: 'tool', content: [{ type: 'text', text: 'DSH_WEB_TOOL_OK\n' }] },
        },
      },
    },
    {
      type: 'event',
      event: {
        type: 'turn/end',
        seq: 4,
        time: 4,
        data: { reason: { kind: 'completed' } },
      },
    },
  ],
  hasMore: false,
}

describe('DSH Web E2E contract helpers', () => {
  it('accepts only a bare loopback readiness origin', () => {
    expect(parseDshReadyUrl('booting\ndsh web: http://127.0.0.1:43123\n')).toBe(
      'http://127.0.0.1:43123',
    )
    expect(parseDshReadyUrl('booting')).toBeUndefined()
    for (const value of [
      'http://0.0.0.0:1',
      'https://127.0.0.1:1',
      'http://user@127.0.0.1:1',
      'http://127.0.0.1:1/path',
      'http://127.0.0.1',
      'http://127.0.0.1:1/?other=1',
      'http://127.0.0.1:1/?token=a&token=b',
      'http://127.0.0.1:1/?token=',
      'http://127.0.0.1:1/path?token=a',
    ]) {
      expect(() => parseDshReadyUrl(`dsh web: ${value}`)).toThrow()
    }
  })

  it('separates the DSH 0.2 launch token from the loopback origin', () => {
    expect(parseDshWebLaunch('dsh web: http://127.0.0.1:43123/?token=abc_-1\n')).toEqual({
      origin: 'http://127.0.0.1:43123',
      launchUrl: 'http://127.0.0.1:43123/?token=abc_-1',
    })
    expect(parseDshReadyUrl('dsh web: http://127.0.0.1:43123/?token=abc')).toBe(
      'http://127.0.0.1:43123',
    )
  })

  it('exchanges the launch token for the session cookie sent with later requests', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('token=')) {
        expect(init?.redirect).toBe('manual')
        return new Response(null, {
          status: 303,
          headers: { location: './', 'set-cookie': 'dsh-auth-x=signed; Path=/; HttpOnly' },
        })
      }
      return response({ cookie: new Headers(init?.headers).get('cookie') })
    })
    const authenticated = await authenticateDshWeb(fetcher, 'http://127.0.0.1:1/?token=abc')
    const reply = await authenticated('http://127.0.0.1:1/api/x', {
      headers: { 'content-type': 'application/json' },
    })
    expect(await reply.json()).toEqual({ cookie: 'dsh-auth-x=signed' })
    await expect(authenticateDshWeb(fetcher, 'http://127.0.0.1:1/')).resolves.toBe(fetcher)

    const rejecting = vi.fn(async () => new Response(null, { status: 401 }))
    await expect(authenticateDshWeb(rejecting, 'http://127.0.0.1:1/?token=bad')).rejects.toThrow(
      /HTTP 401/,
    )
  })

  it('uses the public unary envelope and unwraps a successful result', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response({ rpcId: 'r1', result: { ok: true, value: { accepted: true } } }),
    )
    await expect(
      dshRpc<{ accepted: true }>(
        fetcher,
        'http://127.0.0.1:43210',
        'session/prompt',
        { request: { marker: 'not echoed' } },
        'r1',
      ),
    ).resolves.toEqual({ accepted: true })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:43210/api/session/prompt',
      expect.objectContaining({ method: 'POST' }),
    )
    const init = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'client-request',
      rpcId: 'r1',
      method: 'session/prompt',
      payload: { args: { request: { marker: 'not echoed' } } },
    })
  })

  it('keeps remote RPC messages out of the thrown summary and stable report code', async () => {
    const fetcher = vi.fn(async () =>
      response({
        result: {
          ok: false,
          error: { code: 'session/model-unavailable', message: '/private/user/secret prompt' },
        },
      }),
    )
    const failure = await dshRpc(
      fetcher,
      'http://127.0.0.1:43210',
      'session/selectModel',
      {},
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DshRpcError)
    expect(String(failure)).not.toContain('secret')
    expect(stableFailureCode(failure)).toBe('RPC_SESSION_MODEL_UNAVAILABLE')
  })

  it('fails closed for invalid methods, HTTP failures, and malformed envelopes', async () => {
    const unused = vi.fn()
    for (const method of ['../bad', 'session.list', 'session/list/extra']) {
      await expect(dshRpc(unused, 'http://127.0.0.1:1', method, {})).rejects.toThrow(
        'invalid shape',
      )
    }
    await expect(
      dshRpc(async () => response({}, 503), 'http://127.0.0.1:1', 'session/list', {}),
    ).rejects.toThrow('HTTP 503')
    await expect(
      dshRpc(async () => response({ result: {} }), 'http://127.0.0.1:1', 'session/list', {}),
    ).rejects.toThrow('boolean ok')
  })

  it('validates the selected Claude route, aliases, and reasoning levels', () => {
    expect(inspectClaudeCatalog(models)).toEqual({
      provider: 'claude-code',
      selectedModel: 'default',
      routable: true,
      aliases: ['default', 'sonnet', 'opus', 'haiku'],
      reasoningEfforts: ['low', 'medium', 'high'],
    })
    expect(() => inspectClaudeCatalog({ ...models, routableProviders: [] })).toThrow('not routable')
    expect(() =>
      inspectClaudeCatalog({
        ...models,
        default: { provider: 'deepseek-official', model: 'default' },
      }),
    ).toThrow('did not default')
    expect(() =>
      inspectClaudeCatalog({ ...models, groups: [{ ...models.groups[0], models: [] }] }),
    ).toThrow('aliases changed')
  })

  it('extracts marker predicates and payload-free history evidence', () => {
    expect(historyAssistantMarkerCount(history, 'DSH_WEB_TEXT_OK')).toBe(1)
    expect(historyAssistantMarkerCount(history, 'secret')).toBe(0)
    expect(historyHasAssistantMarker(history, 'DSH_WEB_TEXT_OK')).toBe(true)
    expect(historyHasAssistantMarker(history, 'secret')).toBe(false)
    expect(historyHasToolResultMarker(history, 'DSH_WEB_TOOL_OK')).toBe(true)
    expect(summarizeHistory(history)).toEqual({
      eventCount: 4,
      maxSeq: 4,
      eventTypes: ['assistant/message', 'tool/call', 'tool/result', 'turn/end'],
      assistantMessageCount: 1,
      assistantTextCharacters: 15,
      toolCalls: ['bash'],
      toolResultCount: 1,
      turnEndKinds: ['completed'],
    })
    expect(JSON.stringify(summarizeHistory(history))).not.toContain('redacted')
    expect(JSON.stringify(summarizeHistory(history))).not.toContain('DSH_WEB_TOOL_OK')
  })

  it('rejects malformed catalog and history shapes', () => {
    expect(() => inspectClaudeCatalog(null)).toThrow('must be an object')
    expect(() => historyHasAssistantMarker({ records: {} }, 'x')).toThrow('must be an array')
    expect(stableFailureCode(new Error('/private/path'))).toBe('UNEXPECTED')
  })
})
