import { canonicalJson } from './canonical-json.js'
import { toolProtocolError } from './errors.js'

export function canonicalToolJson(value: unknown): string {
  return canonicalJson(value, (message) => toolProtocolError(message))
}
