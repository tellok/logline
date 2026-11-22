import { isSensitiveKey, maskString, sensitiveReplacer } from './masking';
import { type LogTags } from './types';

/**
 * Tag keys stay within the Explorer queryable segment pattern.
 */
const TAG_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_TAGS = 16;
const MAX_TAG_VALUE_LENGTH = 256;

/**
 * Normalize user-supplied tags into a flat, masked, queryable map.
 * Invalid keys, non-string or empty values, and entries beyond the cap are dropped.
 * Values pass through masking; sensitive key names collapse to '***'.
 * Never throws: exotic inputs such as Proxies with throwing traps yield undefined.
 * @param input Candidate tag map from a log call or configuration.
 * @returns Normalized tags, or undefined when nothing survives.
 */
export const normalizeTags = (input: unknown): LogTags | undefined => {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    const out: Record<string, string> = {};
    for (const key of Object.keys(input)) {
      if (Object.keys(out).length >= MAX_TAGS) break;
      if (!TAG_KEY_PATTERN.test(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const value = descriptor.value;
      if (typeof value !== 'string' || value.length === 0) continue;
      out[key] = isSensitiveKey(key) ? '***' : maskString(value.slice(0, MAX_TAG_VALUE_LENGTH));
    }
    return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Merge global tags with per-record tags; record entries win.
 * @param base Global configured tags.
 * @param override Per-record tags.
 */
export const mergeTags = (base: LogTags | undefined, override: LogTags | undefined): LogTags | undefined => {
  if (!base) return override;
  if (!override) return base;
  // Record keys win on conflicts and come first, so the cap drops global extras first.
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(override)) merged[key] = value;
  for (const [key, value] of Object.entries(base)) {
    if (!(key in merged)) merged[key] = value;
  }
  const keys = Object.keys(merged);
  if (keys.length > MAX_TAGS) {
    for (const key of keys.slice(MAX_TAGS)) delete merged[key];
  }
  return Object.freeze(merged);
};

/**
 * Serialize values safely so JSON.stringify failures do not interrupt logging.
 * @param value Value to serialize.
 */
export const safeStringify = (value: unknown): string => {
  // Mask strings directly.
  if (typeof value === 'string') {
    return maskString(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  try {
    // Track visited objects with WeakSet to tolerate cyclic references.
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (key, val: unknown) => {
      // Serialize non-enumerable Error fields explicitly instead of producing an empty object.
      if (val instanceof Error) {
        return {
          message: val.message,
          name: val.name,
          stack: val.stack,
        };
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return sensitiveReplacer(key, val);
    });
  } catch {
    // String conversion can also fail for objects lacking toString/valueOf; provide a fallback.
    try {
      return maskString(String(value));
    } catch {
      return '[Unserializable]';
    }
  }
};

/**
 * Safely serialize and truncate a value for compact log previews.
 * Use safeStringify for serialization and sensitive-field masking.
 * Truncate to maxLength and append an ellipsis when necessary.
 *
 * @param value     Value to serialize.
 * @param maxLength Maximum characters; defaults to 100, with -1 disabling truncation.
 * @returns Serialized string, truncated when necessary.
 *
 * @example
 * ```ts
 * peekObject({ foo: 'bar', list: [1,2,3] });
 * // => '{"foo":"bar","list":[1,2,3]}'  (if at most 100 characters)
 *
 * peekObject(someLargeObject);
 * // => '{"id":1,"name":"test","nested":{"deeply":{"value":"v...…'  (truncated to 100 characters)
 *
 * peekObject(someLargeObject, -1);
 * // => Complete JSON string without truncation.
 *
 * peekObject(someLargeObject, 50);
 * // => Truncated to 50 characters.
 * ```
 */
export const peekObject = (value: unknown, maxLength: number = 100): string => {
  const serialized = safeStringify(value);
  if (maxLength === -1 || serialized.length <= maxLength) {
    return serialized;
  }
  return `${serialized.slice(0, maxLength)}…`;
};
