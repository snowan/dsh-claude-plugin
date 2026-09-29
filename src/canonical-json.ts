/** Builds the error thrown for a value that has no lossless canonical JSON form. */
export type CanonicalJsonError = (message: string) => Error

function normalizedJson(
  value: unknown,
  path: string,
  invalid: CanonicalJsonError,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') {
    throw invalid(`tool JSON at ${path} contains a non-JSON value`)
  }
  if (ancestors.has(value)) throw invalid(`tool JSON at ${path} contains a cycle`)
  ancestors.add(value)
  let output: unknown
  if (Array.isArray(value)) {
    output = value.map((entry, index) =>
      normalizedJson(entry, `${path}[${index}]`, invalid, ancestors),
    )
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(`tool JSON at ${path} must contain only plain objects`)
    }
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) {
      record[key] = normalizedJson(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        invalid,
        ancestors,
      )
    }
    output = record
  }
  ancestors.delete(value)
  return output
}

/**
 * Serialize plain JSON data with sorted object keys. This module imports no
 * DSH package, so the CLI's `verify-profile` command runs under plain Node.
 * @param value - plain JSON data.
 * @param invalid - builds the error thrown for non-JSON values, cycles, and class instances.
 * @returns the canonical JSON text.
 */
export function canonicalJson(value: unknown, invalid: CanonicalJsonError): string {
  return JSON.stringify(normalizedJson(value, '$', invalid))
}
