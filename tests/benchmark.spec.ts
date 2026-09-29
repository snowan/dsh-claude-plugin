import { describe, expect, it } from 'vitest'
import {
  BENCHMARK_SCHEMA_VERSION,
  analyzeBenchmark,
  benchmarkTerminalSuccess,
  benchmarkTranscriptInvariant,
  digestBenchmarkText,
  distribution,
  renderBenchmarkMarkdown,
  validateBenchmarkObservation,
  type BenchmarkLane,
  type BenchmarkObservation,
} from '../src/benchmark.js'

function observation(
  lane: BenchmarkLane,
  repetition: number,
  overrides: Partial<BenchmarkObservation> = {},
): BenchmarkObservation {
  const output = digestBenchmarkText('BENCHMARK_OK')
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId: 'run-1',
    environmentId: 'environment-1',
    scenarioId: 'text.exact',
    category: 'text',
    core: true,
    lane,
    phase: 'measured',
    repetition,
    model: 'sonnet',
    effort: 'medium',
    success: true,
    correctness: { pass: true, checks: ['exact-output'], failedChecks: [] },
    output,
    expectedOutput: output,
    durationMs: lane === 'direct' ? 100 : 115,
    firstTokenMs: lane === 'direct' ? 40 : 44,
    cleanupMs: 2,
    textDeltaCount: 2,
    reasoningDeltaCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    duplicateBlockCount: 0,
    missingBlockCount: 0,
    childProcessesLeaked: 0,
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.001,
    },
    invariants: {
      cleanup: true,
      toolCorrelation: true,
      policy: true,
      transcript: true,
      redaction: true,
    },
    ...overrides,
  }
}

function paired(count = 5, overrides: Partial<BenchmarkObservation> = {}): BenchmarkObservation[] {
  return Array.from({ length: count }, (_, repetition) => [
    observation('direct', repetition, overrides),
    observation('dsh', repetition, overrides),
  ]).flat()
}

describe('benchmark evidence primitives', () => {
  it('requires a clean terminal path and passing grader for every successful lane', () => {
    expect(benchmarkTerminalSuccess(undefined, true)).toBe(true)
    expect(benchmarkTerminalSuccess('ABORTED', true)).toBe(false)
    expect(benchmarkTerminalSuccess(undefined, false)).toBe(false)
  })

  it('treats transcript integrity as structural evidence rather than task correctness', () => {
    expect(benchmarkTranscriptInvariant(0, 0)).toBe(true)
    expect(benchmarkTranscriptInvariant(1, 0)).toBe(false)
    expect(benchmarkTranscriptInvariant(0, 1)).toBe(false)
    expect(() => benchmarkTranscriptInvariant(-1, 0)).toThrow(/duplicateBlockCount/)
  })

  it('hashes UTF-8 output without retaining its text', () => {
    const digest = digestBenchmarkText('你好🙂')
    expect(digest).toEqual({
      algorithm: 'sha256',
      digest: 'b2cfe03dfa743d80691190c5800deaf375b6a7058806f88d256c0ace8bc4b51e',
      bytes: 10,
    })
    expect(JSON.stringify(digest)).not.toContain('你好')
  })

  it('calculates nearest-rank p95 and even/odd medians', () => {
    expect(distribution([])).toBeUndefined()
    expect(distribution([5])).toEqual({ count: 1, min: 5, median: 5, p95: 5, max: 5 })
    expect(distribution([9, 1, 5, 3])).toEqual({
      count: 4,
      min: 1,
      median: 4,
      p95: 9,
      max: 9,
    })
    expect(distribution([9, 1, 5])).toMatchObject({ median: 5, p95: 9 })
    expect(() => distribution([-1])).toThrow(/non-negative/)
  })

  it('accepts a bounded sanitized observation and rejects invalid evidence', () => {
    const valid = observation('direct', 0, {
      firstToolRequestMs: 12,
      cancellationMs: 20,
      failureCode: 'EXPECTED_FAILURE',
    })
    expect(validateBenchmarkObservation(valid)).toBe(valid)
    expect(() => validateBenchmarkObservation({ ...valid, schemaVersion: 2 as never })).toThrow(
      /schema version/,
    )
    expect(() => validateBenchmarkObservation({ ...valid, runId: '../unsafe' })).toThrow(/runId/)
    expect(() => validateBenchmarkObservation({ ...valid, lane: 'other' as never })).toThrow(/lane/)
    expect(() => validateBenchmarkObservation({ ...valid, phase: 'other' as never })).toThrow(
      /phase/,
    )
    expect(() => validateBenchmarkObservation({ ...valid, core: 'yes' as never })).toThrow(/flags/)
    expect(() => validateBenchmarkObservation({ ...valid, model: 'bad model' })).toThrow(
      /model or effort/,
    )
    expect(() =>
      validateBenchmarkObservation({
        ...valid,
        correctness: { pass: true, checks: null as never, failedChecks: [] },
      }),
    ).toThrow(/correctness evidence/)
    expect(() => validateBenchmarkObservation({ ...valid, repetition: -1 })).toThrow(/repetition/)
    expect(() => validateBenchmarkObservation({ ...valid, durationMs: Number.NaN })).toThrow(
      /durationMs/,
    )
    expect(() => validateBenchmarkObservation({ ...valid, cleanupMs: -1 })).toThrow(/cleanupMs/)
    expect(() => validateBenchmarkObservation({ ...valid, firstTokenMs: -1 })).toThrow(
      /firstTokenMs/,
    )
    expect(() => validateBenchmarkObservation({ ...valid, textDeltaCount: 0.5 })).toThrow(
      /textDeltaCount/,
    )
    expect(() =>
      validateBenchmarkObservation({ ...valid, output: { ...valid.output, digest: 'bad' } }),
    ).toThrow(/output digest/)
    expect(() =>
      validateBenchmarkObservation({
        ...valid,
        output: { ...valid.output, algorithm: 'md5' as never },
      }),
    ).toThrow(/output digest/)
    expect(() =>
      validateBenchmarkObservation({
        ...valid,
        expectedOutput: { ...valid.output, digest: 'bad' },
      }),
    ).toThrow(/expected digest/)
    expect(() => validateBenchmarkObservation({ ...valid, failureCode: 'bad code' })).toThrow(
      /failureCode/,
    )
    expect(() =>
      validateBenchmarkObservation({
        ...valid,
        usage: { ...valid.usage!, inputTokens: -1 },
      }),
    ).toThrow(/usage.inputTokens/)
    expect(() =>
      validateBenchmarkObservation({
        ...valid,
        usage: { ...valid.usage!, estimatedCostUsd: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/estimatedCostUsd/)
    expect(() =>
      validateBenchmarkObservation({
        ...valid,
        invariants: { ...valid.invariants, cleanup: 'yes' as never },
      }),
    ).toThrow(/invariants/)
    expect(() =>
      validateBenchmarkObservation({
        ...valid,
        correctness: { pass: false, checks: [], failedChecks: ['bad'] },
      }),
    ).toThrow(/must pass correctness/)
  })
})

describe('benchmark analysis', () => {
  it('excludes warm-ups and reports paired latency, success, and digest agreement', () => {
    const warmups = [
      observation('direct', 0, { phase: 'warmup', durationMs: 9_999 }),
      observation('dsh', 0, { phase: 'warmup', durationMs: 99_999 }),
    ]
    const analysis = analyzeBenchmark([...warmups, ...paired()])
    expect(analysis).toMatchObject({
      measuredObservations: 10,
      comparableScenarios: 1,
      complete: true,
      scenarios: [
        {
          pairedSamples: 5,
          latencyOverheadPercent: 15,
          successLossPoints: 0,
          outputAgreementRate: 100,
          direct: { durationMs: { median: 100 }, firstTokenMs: { median: 40 } },
          dsh: { durationMs: { median: 115 }, firstTokenMs: { median: 44 } },
        },
      ],
    })
    expect(analysis.weaknesses).toEqual([])
  })

  it('classifies high latency and success-rate loss as P1', () => {
    const entries = paired().map((entry) =>
      entry.lane === 'dsh' ? { ...entry, durationMs: 130 } : entry,
    )
    entries[1] = {
      ...entries[1]!,
      success: false,
      correctness: { pass: false, checks: ['exact-output'], failedChecks: ['exact-output'] },
      failureCode: 'REPLY_MISMATCH',
    }
    const analysis = analyzeBenchmark(entries)
    expect(analysis.scenarios[0]).toMatchObject({
      latencyOverheadPercent: 30,
      successLossPoints: 20,
    })
    expect(analysis.weaknesses.map((entry) => entry.code)).toEqual([
      'P1_LATENCY_OVERHEAD',
      'P1_SUCCESS_RATE_LOSS',
    ])
  })

  it('raises P0 for consistent core failure and every safety invariant', () => {
    const entries = paired(3).map((entry) =>
      entry.lane === 'dsh'
        ? {
            ...entry,
            success: false,
            correctness: { pass: false, checks: [], failedChecks: ['terminal'] },
            childProcessesLeaked: 2,
            invariants: {
              cleanup: false,
              toolCorrelation: false,
              policy: false,
              transcript: false,
              redaction: false,
            },
            failureCode: 'PLUGIN_FAILED',
          }
        : entry,
    )
    const codes = analyzeBenchmark(entries).weaknesses.map((entry) => entry.code)
    expect(codes).toContain('P0_CORE_PARITY_FAILURE')
    expect(codes).toContain('P0_PROCESS_CLEANUP')
    expect(codes).toContain('P0_TOOL_CORRELATION')
    expect(codes).toContain('P0_POLICY_ESCAPE')
    expect(codes).toContain('P0_TRANSCRIPT_DIVERGENCE')
    expect(codes).toContain('P0_REDACTION_FAILURE')
    expect(codes).toContain('P0_CHILD_PROCESS_LEAK')
    expect(codes).toContain('P2_INSUFFICIENT_LATENCY_SAMPLES')
    expect(codes.filter((code) => code === 'P0_PROCESS_CLEANUP')).toHaveLength(1)
  })

  it('labels missing or incompatible pairs and refuses a completed claim', () => {
    const missing = analyzeBenchmark([observation('direct', 0)])
    expect(missing).toMatchObject({ complete: false, comparableScenarios: 0 })
    expect(missing.weaknesses).toEqual([
      expect.objectContaining({ severity: 'P2', code: 'P2_INCOMPLETE_PAIRING' }),
    ])

    const incompatible = analyzeBenchmark([
      observation('direct', 0),
      observation('dsh', 0, { model: 'opus' }),
    ])
    expect(incompatible.scenarios[0]?.comparable).toBe(false)
    expect(incompatible.weaknesses[0]?.code).toBe('P2_INCOMPLETE_PAIRING')
  })

  it('rejects duplicate lane observations for the same pair', () => {
    expect(() => analyzeBenchmark([observation('direct', 0), observation('direct', 0)])).toThrow(
      /duplicate direct/,
    )
  })

  it('handles empty and failed samples without inventing latency or agreement', () => {
    expect(analyzeBenchmark([])).toEqual({
      scenarios: [],
      weaknesses: [],
      measuredObservations: 0,
      comparableScenarios: 0,
      complete: false,
    })
    const failed = paired(1).map((entry) => ({
      ...entry,
      success: false,
      correctness: { pass: false, checks: ['terminal'], failedChecks: ['terminal'] },
      failureCode: 'EXPECTED',
    }))
    const scenario = analyzeBenchmark(failed).scenarios[0]
    expect(scenario).toMatchObject({ pairedSamples: 1, successLossPoints: 0 })
    expect(scenario?.direct.durationMs).toBeUndefined()
    expect(scenario?.latencyOverheadPercent).toBeUndefined()
    expect(scenario?.outputAgreementRate).toBeUndefined()
  })
})

describe('benchmark report rendering', () => {
  const environment = {
    generatedAt: '2026-08-23T00:00:00.000Z',
    commit: 'abc123',
    branch: 'michi/benchmarks',
    dirty: false,
    node: 'v24.0.0',
    platform: 'darwin',
    arch: 'arm64',
    dsh: '0.2.0-rc.2',
    sdk: '0.3.241',
    claudeCode: '2.1.241',
    model: 'sonnet',
    effort: 'medium',
    warmups: 1,
    repetitions: 5,
    resultsPath: '.artifacts/benchmark.jsonl',
  } as const

  it('renders a complete sanitized report with primary references', () => {
    const report = renderBenchmarkMarkdown(environment, analyzeBenchmark(paired()))
    expect(report).toContain('Status: complete')
    expect(report).toContain('text.exact | 5/5 | 5/5')
    expect(report).toContain('15%')
    expect(report).toContain('https://code.claude.com/docs/en/agent-sdk/streaming-output')
    expect(report).toContain(
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.md',
    )
    expect(report).not.toContain('BENCHMARK_OK')
  })

  it('renders incomplete and weakness states without claiming measurements', () => {
    const empty = renderBenchmarkMarkdown(environment, analyzeBenchmark([]))
    expect(empty).toContain('Status: incomplete')
    expect(empty).toContain('No authenticated measurements.')
    expect(empty).toContain('None detected by the completed measurements.')

    const weak = renderBenchmarkMarkdown(
      environment,
      analyzeBenchmark([
        observation('direct', 0),
        observation('dsh', 0, {
          success: false,
          correctness: { pass: false, checks: [], failedChecks: ['terminal'] },
          invariants: {
            cleanup: false,
            toolCorrelation: true,
            policy: true,
            transcript: true,
            redaction: true,
          },
          failureCode: 'FAIL',
        }),
      ]),
    )
    expect(weak).toContain('P0 P0_PROCESS_CLEANUP')
    expect(weak).toContain('P2 P2_INSUFFICIENT_LATENCY_SAMPLES')
  })
})
