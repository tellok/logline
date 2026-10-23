/**
 * Known sensitive keys, stored lowercase and matched case-insensitively.
 */
const SENSITIVE_KEYS = [
  'id_token',
  'client_secret',
  'access_token',
  'refresh_token',
  'accesstoken',
  'refreshtoken',
  'password',
  'authorization',
  'session',
  'ticket',
  'secret',
  'token',
  'auth_code',
  'authcode',
  'verify_code',
  'verifycode',
  'verification_code',
  'auth',
  'key',
  'pwd',
  'cookie',
  'phone',
  'phoneno',
  'phone_no',
  'telno',
  'tel_no',
  'tel',
];

/**
 * Match key=value pairs without whitespace around the equals sign.
 * Capture groups: prefix, key, and value.
 */
const KEY_VALUE_REGEX = /(^|[\s?&,;]+)([\w\-.@]+)=([^?&,;\s]*)/gi;

/**
 * Build a flexible delimiter pattern for known sensitive keys.
 * Accept equals signs with whitespace, colons, full-width colons, and whitespace delimiters.
 * Capture groups: prefix, key, delimiter, and value.
 */
const buildSensitiveKeySeparatorRegex = (): RegExp => {
  // Match longer keys first, such as access_token before token.
  const sorted = [...SENSITIVE_KEYS].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const keysPattern = escaped.join('|');
  return new RegExp(`(^|[\\s?&,;]+)(${keysPattern})(\\s*[=:：]\\s*|\\s+)([^?&,;：=\\s]*)`, 'gi');
};

const SENSITIVE_KEY_SEPARATOR_REGEX = buildSensitiveKeySeparatorRegex();

/**
 * Sensitive multiword keys such as phone number and tel number.
 */
const SENSITIVE_MULTIWORD_KEYS = ['phone number', 'tel number'];

/**
 * Build a multiword key pattern allowing one or more spaces between words.
 * Accept equals signs with whitespace, colons, full-width colons, and whitespace delimiters.
 * Capture groups: prefix, key, delimiter, and value.
 */
const buildSensitiveMultiwordKeyRegex = (): RegExp => {
  const sorted = [...SENSITIVE_MULTIWORD_KEYS].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  const keysPattern = escaped.join('|');
  return new RegExp(`(^|[\\s?&,;]+)(${keysPattern})(\\s*[=:：]\\s*|\\s+)([^?&,;：=\\s]*)`, 'gi');
};

const SENSITIVE_MULTIWORD_KEY_REGEX = buildSensitiveMultiwordKeyRegex();

function isHeuristicSecret(value: string): boolean {
  if (!value) return false;

  // Treat digit strings of at least ten characters as potentially sensitive.
  if (value.length >= 10 && /^\d+$/.test(value)) {
    return true;
  }

  // Recognize international phone numbers: a plus sign followed by 8 to 15 digits.
  if (/^\+\d{8,15}$/.test(value)) {
    return true;
  }

  // Recognize alphanumeric and Base64 strings of at least eighteen characters.
  if (value.length < 18 || !/^[a-zA-Z0-9+/=]+$/.test(value)) {
    return false;
  }
  // Require both digits and letters.
  if (!/\d/.test(value) || !/[a-zA-Z]/.test(value)) {
    return false;
  }
  // Require a non-hexadecimal letter or a Base64 plus/slash character.
  // Exclude hexadecimal hashes such as SHA and MD5.
  if (!/[g-zG-Z+/]/.test(value)) {
    return false;
  }
  return true;
}

/**
 * Keys excluded from heuristic detection, matched case-insensitively.
 * Keep these values visible to avoid false positives for timestamps and pagination.
 */
const HEURISTIC_EXEMPT_KEYS = new Set([
  't',
  'ts',
  'timestamp',
  'time',
  'v',
  'ver',
  'version',
  'n',
  'id',
  'uid',
  'pid',
  'page',
  'size',
  'limit',
  'offset',
  'count',
  'total',
  'code',
  'status',
  'errno',
  'errcode',
  'err_code',
  'error_code',
  'cmdname',
]);

const isHeuristicExemptKey = (key: string): boolean => {
  return HEURISTIC_EXEMPT_KEYS.has(key.toLowerCase());
};

/**
 * Mask sensitive content within a string.
 *
 * Scan key/value forms followed by flexible sensitive-key delimiters:
 * 1. Mask sensitive keys or heuristic secrets in arbitrary key=value pairs.
 * 2. Match flexible delimiters for known sensitive keys:
 *    key=value / key = value / key:value / key：value / key value
 */
export const maskString = (str: string): string => {
  if (!str) return str;

  // Pass 1: Handle key=value without surrounding whitespace.
  let result = str.replace(KEY_VALUE_REGEX, (match, prefix: string, key: string, value: string) => {
    if (isSensitiveKey(key)) {
      return `${prefix}${key}=***`;
    }
    // Skip heuristics for excluded keys to keep timestamps and similar values visible.
    if (!isHeuristicExemptKey(key) && isHeuristicSecret(value)) {
      return `${prefix}${key}=***`;
    }
    return match;
  });

  // Pass 2: Handle sensitive keys with equals, colon, full-width colon, or whitespace delimiters.
  result = result.replace(
    SENSITIVE_KEY_SEPARATOR_REGEX,
    (match: string, prefix: string, key: string, sep: string, value: string, offset: number, fullString: string) => {
      // A captured value followed by equals is actually the next key; do not mask it.
      const endPos = offset + match.length;
      if (endPos < fullString.length && fullString[endPos] === '=') {
        return match;
      }
      // Leave empty values unchanged.
      if (!value) return match;
      // For whitespace-only delimiters, mask only values matching the sensitivity heuristic.
      // Avoid false positives for natural language such as session expired.
      if (!/[=:：]/.test(sep)) {
        if (!isHeuristicSecret(value)) {
          return match;
        }
      }
      return `${prefix}${key}${sep}***`;
    },
  );

  // Pass 3: Handle sensitive multiword keys such as phone number and tel number.
  result = result.replace(
    SENSITIVE_MULTIWORD_KEY_REGEX,
    (match: string, prefix: string, key: string, sep: string, value: string, offset: number, fullString: string) => {
      // A captured value followed by equals is the next key; leave it visible.
      const endPos = offset + match.length;
      if (endPos < fullString.length && fullString[endPos] === '=') {
        return match;
      }
      if (!value) return match;
      // For whitespace delimiters, require the heuristic to avoid natural-language false positives.
      if (!/[=:：]/.test(sep)) {
        if (!isHeuristicSecret(value)) {
          return match;
        }
      }
      return `${prefix}${key}${sep}***`;
    },
  );

  return result;
};

/**
 * Check whether a key is sensitive, ignoring case.
 */
export const isSensitiveKey = (key: string): boolean => {
  if (!key) return false;
  return SENSITIVE_KEYS.includes(key.toLowerCase());
};

/**
 * JSON.stringify replacer masking sensitive fields and string content.
 */
export const sensitiveReplacer = (key: string, value: unknown): unknown => {
  if (key && isSensitiveKey(key)) {
    return '***';
  }
  if (typeof value === 'string') {
    return maskString(value);
  }
  return value;
};
