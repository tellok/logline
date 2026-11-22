import type { LogLevelName } from '../../core/constants';
import { isSensitiveKey, maskString } from '../../core/masking';
import type { LogRecord } from '../../core/types';

/** JSON data copied by value. No user objects or callbacks reach the transport. */
export type ReportingJsonValue = string | number | boolean | null | readonly ReportingJsonValue[] | ReportingFields;
interface ReportingFields {
  readonly [key: string]: ReportingJsonValue;
}

/** Immutable delivery envelope. `timestamp` is epoch milliseconds, not the delivery ID. */
export interface ReportingEvent {
  readonly id: string;
  readonly level: LogLevelName;
  readonly timestamp: number;
  readonly message: string;
  readonly fields?: ReportingFields;
  readonly context?: ReportingFields;
  /**
   * Flat string key/value tags; filterable, searchable and aggregatable on the server.
   */
  readonly tags?: ReportingFields;
}

// JS has no lazy bounded own-key iterator. Even for-in can materialize millions of names before its first iteration.
// Probe a small schema instead. Callers opt into their own application field names with snapshotKeys.
const standardKeys = [
  'name',
  'message',
  'stack',
  'cause',
  'code',
  'status',
  'id',
  'type',
  'value',
  'data',
  'details',
  'error',
  'nested',
  'environment',
  'release',
  'traceId',
  'sessionId',
  'userId',
  'user',
  'durationMs',
  'count',
  'token',
  'password',
  'authorization',
  'secret',
  'cookie',
  'session',
  'scope',
  'key',
  'template',
  'arguments',
  'epochMs',
  'sequence',
  'stableTimeMs',
];
const contextStrings = new Set(['environment', 'release', 'traceId', 'sessionId', 'userId']);
const errorNames = new Map<object, string>(
  [Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError].map((type) => [
    type.prototype,
    type.name,
  ]),
);
const truncated = '[Truncated]';
const accessor = '[Accessor]';
const absent = Symbol('absent');
const maxItems = 16;

/** Read own data only, never invoke application accessors, inherited properties, iterators or toJSON. */
function own(input: object, key: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return absent;
  return 'value' in descriptor ? descriptor.value : accessor;
}

function schemaKeys(extra: readonly string[]): ReadonlySet<string> {
  const result = new Set(standardKeys);
  for (let index = 0; index < Math.min(extra.length, 24); index++) {
    const key = own(extra, index);
    if (
      typeof key === 'string' &&
      key.length <= 64 &&
      /^[\w.-]+$/.test(key) &&
      !['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)
    )
      result.add(key);
  }
  return result;
}

// Be conservative with authorization schemes, quoted JSON and spaces in credentials. Core masking handles heuristic
// values too. Erase the rest of a sensitive assignment's line rather than exposing a trailing word in a password.
function maskText(input: string): string {
  const safe = input.replace(/ll(?:pk|pat)_[A-Za-z0-9_-]{43}/g, '***').replace(/\b(bearer|basic)\s+\S+/gi, '$1 ***');
  const assignment = /(?<![\w.-])([\w.-]+)["']?(?:\s*[:=：]\s*|\s+|$)/g;
  for (const match of safe.matchAll(assignment)) {
    if (match[1].length <= 64 && isSensitiveKey(match[1])) {
      return maskString(safe.slice(0, match.index) + match[0] + '***');
    }
  }
  return maskString(safe);
}

function budget(keys: ReadonlySet<string>) {
  let remainingChars = 8192;
  let remainingNodes = 96;
  const ancestors = new WeakSet<object>();
  function text(input: string, max = 2048, stack = false): string {
    // Do not even slice a giant rope: an engine may flatten its entire backing string to read a prefix.
    if (input.length > Math.min(max, remainingChars)) return truncated;
    remainingChars -= input.length;
    // Preserve ordinary stack frames after a masked error message; keep multiline credentials within a single redaction unit.
    return stack
      ? input
          .split(/\n(?=\s*at\s)/)
          .map(maskText)
          .join('\n')
      : maskText(input);
  }
  function fields(input: object, depth: number, context = false): ReportingFields {
    const out: Record<string, ReportingJsonValue> = Object.create(null);
    const errorName = errorNames.get(Object.getPrototypeOf(input));
    if (errorName) out.name = errorName;
    for (const key of keys) {
      if (remainingNodes <= 0) break;
      const property = own(input, key);
      if (property === absent) continue;
      if (context && contextStrings.has(key)) {
        if (typeof property === 'string') out[key] = text(property, 256);
      } else if (isSensitiveKey(key)) {
        out[key] = '***';
      } else {
        out[key] = value(property, depth + 1, key === 'stack');
      }
    }
    return Object.freeze(out);
  }
  // Tags carry application-defined key names, so they cannot be probed from the schema list.
  // Object.keys never invokes accessors; values are read through own data descriptors only.
  function tags(input: object): ReportingFields {
    const out: Record<string, ReportingJsonValue> = Object.create(null);
    let count = 0;
    for (const key of Object.keys(input)) {
      if (count >= 16 || remainingNodes <= 0) break;
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
      const property = own(input, key);
      if (property === absent || property === accessor || typeof property !== 'string' || property.length === 0)
        continue;
      count += 1;
      remainingNodes -= 1;
      out[key] = isSensitiveKey(key) ? '***' : text(property, 256);
    }
    return Object.freeze(out);
  }
  function list(input: readonly unknown[], start: number, depth: number): readonly ReportingJsonValue[] {
    const out: ReportingJsonValue[] = [];
    let index = start;
    const length = input.length;
    for (; index < length && index - start < maxItems && remainingNodes > 0; index++) {
      const item = value(own(input, index), depth + 1);
      out.push(item);
      if (
        index + 1 < length &&
        typeof item === 'string' &&
        (item === truncated || item.includes('***') || /\b(?:bearer|basic)\s*$/i.test(item))
      ) {
        // Separate console arguments can form a single credential. Do not send the unlabelled tail.
        out.push('***');
        return Object.freeze(out);
      }
    }
    if (index < length) out.push(truncated);
    return Object.freeze(out);
  }
  function value(input: unknown, depth: number, stack = false): ReportingJsonValue {
    if (--remainingNodes < 0) return truncated;
    if (typeof input === 'string') return text(input, 2048, stack);
    if (typeof input === 'boolean' || input === null) return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input !== 'object') return '[Unsupported]';
    if (ancestors.has(input)) return '[Circular]';
    if (depth >= 4) return truncated;
    ancestors.add(input);
    try {
      return Array.isArray(input) ? list(input, 0, depth) : fields(input, depth);
    } catch {
      return '[Unavailable]';
    } finally {
      ancestors.delete(input);
    }
  }
  return { text, fields, value, list, tags };
}

/**
 * Snapshot one admitted record synchronously. Never enumerate arbitrary objects. Unknown object keys are omitted;
 * known accessors and cycles become markers. The caller supplies a unique, retry-stable ID. The detached transform
 * may discard this event; a failure/invalid timestamp also drops only this event. Returns exact compact JSON bytes.
 */
export function createSnapshot(
  record: LogRecord,
  id: string,
  context?: Readonly<Record<string, unknown>>,
  transform?: (event: ReportingEvent) => ReportingEvent | undefined,
  snapshotKeys: readonly string[] = [],
): { event: ReportingEvent; bytes: number } | undefined {
  try {
    const epochMs = own(record.timestamp, 'epochMs');
    const sequence = own(record.timestamp, 'sequence');
    const stableTimeMs = own(record.timestamp, 'stableTimeMs');
    const level = record.level;
    if (
      !id ||
      id.length > 128 ||
      typeof epochMs !== 'number' ||
      typeof sequence !== 'number' ||
      typeof stableTimeMs !== 'number' ||
      ![epochMs, sequence, stableTimeMs].every(Number.isFinite)
    )
      return undefined;
    const timing = { epochMs, sequence, stableTimeMs };
    const keys = schemaKeys(snapshotKeys);
    const copy = budget(keys);
    const args = record.formattedArgs;
    const scoped = Boolean(record.scope && args.length > 1);
    const first = own(args, scoped ? 1 : 0);
    const scope = record.scope ? copy.text(record.scope) : undefined;
    const template = record.messageText === undefined ? undefined : copy.text(record.messageText);
    const rendered = typeof first === 'string' ? copy.text(first) : (template ?? '[Structured log]');
    const message = scope ? `${scope} ${rendered}` : rendered;
    // Use only *unconsumed* args from the formatted record. A masked password=%s would otherwise be accompanied by
    // its original plaintext operand. If the message itself names a secret, don't relay detached trailing operands.
    const start = (scoped ? 1 : 0) + (typeof first === 'string' ? 1 : 0);
    const sensitive =
      rendered === truncated ||
      template === truncated ||
      message.includes('***') ||
      template?.includes('***') ||
      /\b(?:bearer|basic)\s*$/i.test(message);
    const trailing = args.length > start ? (sensitive ? '***' : copy.list(args, start, 0)) : undefined;
    const identity = { id, level, timestamp: epochMs };
    const recordTags = record.tags && typeof record.tags === 'object' ? copy.tags(record.tags) : undefined;
    let event: ReportingEvent = Object.freeze({
      ...identity,
      message,
      fields: Object.freeze({
        ...timing,
        ...(scope && { scope }),
        ...(record.key !== undefined && { key: '***' }),
        ...(template !== undefined && { template }),
        ...(trailing !== undefined && { arguments: trailing }),
      }),
      ...(context && { context: copy.fields(context, 0, true) }),
      ...(recordTags && Object.keys(recordTags).length > 0 && { tags: recordTags }),
    });
    if (transform) {
      const changed = transform(event);
      if (!changed) return undefined;
      if (changed !== event) {
        const clean = budget(keys);
        const transformedMessage = own(changed, 'message');
        if (typeof transformedMessage !== 'string' || transformedMessage === accessor) return undefined;
        const customFields = own(changed, 'fields');
        const customContext = own(changed, 'context');
        const customTags = own(changed, 'tags');
        event = Object.freeze({
          ...identity,
          message: clean.text(transformedMessage),
          fields: Object.freeze({
            ...(customFields && typeof customFields === 'object' ? clean.fields(customFields, 0) : {}),
            ...timing,
          }),
          ...(customContext && typeof customContext === 'object'
            ? { context: clean.fields(customContext, 0, true) }
            : {}),
          ...(customTags && typeof customTags === 'object' ? { tags: clean.tags(customTags) } : {}),
        });
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    return bytes <= 65536 ? { event, bytes } : undefined;
  } catch {
    return undefined;
  }
}
