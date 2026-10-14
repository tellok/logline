import { maskString, sensitiveReplacer } from './masking';

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
