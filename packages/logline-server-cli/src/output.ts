/** Narrow a decoded JSON value to an object before reading properties. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Render control and format characters visibly so server data cannot issue terminal commands. */
export function visible(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
    const escaped = JSON.stringify(character).slice(1, -1);
    return escaped === character ? `\\u{${character.codePointAt(0)?.toString(16)}}` : escaped;
  });
}

const colors: Readonly<Record<string, number>> = { TRACE: 90, DEBUG: 36, LOG: 32, WARN: 33, ERROR: 31 };

function formatEvent(value: unknown, detailed: boolean, color: boolean): string {
  if (!isRecord(value)) throw new Error('The server returned an invalid log record.');
  const { timestamp, level, message, projectId, eventId, context, ...attributes } = value;
  const date = new Date(typeof timestamp === 'number' ? timestamp : NaN);
  if (
    !Number.isFinite(date.valueOf()) ||
    typeof level !== 'string' ||
    typeof message !== 'string' ||
    typeof projectId !== 'string' ||
    typeof eventId !== 'string'
  ) {
    throw new Error('The server returned an invalid log record.');
  }
  const label = visible(level).padEnd(5);
  const tone = Object.hasOwn(colors, level) ? colors[level] : undefined;
  const severity = color && tone !== undefined ? `\x1b[${tone}m${label}\x1b[0m` : label;
  const [first, ...rest] = message.split(/\r?\n/);
  const lines = [`${date.toISOString()}  ${severity}  ${visible(first)}`];
  lines.push(...rest.map((line) => `    ${visible(line)}`));
  const metadata = [`project=${visible(projectId)}`, `event=${visible(eventId)}`];
  for (const key of ['environment', 'release', 'traceId', 'sessionId'] as const) {
    const field = isRecord(context) ? context[key] : undefined;
    if (typeof field === 'string') metadata.push(`${key}=${visible(JSON.stringify(field))}`);
  }
  lines.push(`    ${metadata.join('  ')}`);
  if (detailed) {
    for (const [key, field] of Object.entries({ context, ...attributes })) {
      if (field === undefined) continue;
      const rendered = JSON.stringify(field, undefined, 2).split('\n').map(visible).join('\n    ');
      lines.push(`    ${visible(key)}  ${rendered}`);
    }
  }
  return lines.join('\n');
}

/** Render one Explorer log response for a terminal, including paging and limit indicators. */
export function formatLogs(payload: unknown, detailed: boolean, color: boolean): string {
  if (!isRecord(payload)) throw new Error('The server returned an invalid log response.');
  if (detailed) return `${formatEvent(payload.item, true, color)}\n`;
  if (!Array.isArray(payload.items)) throw new Error('The server returned an invalid log response.');
  const entries = payload.items.map((item: unknown) => formatEvent(item, false, color));
  if (entries.length === 0) entries.push('No logs found.');
  if (typeof payload.nextCursor === 'string') entries.push(`Next page  --cursor ${visible(payload.nextCursor)}`);
  else if (payload.limited === true) entries.push('The server limited this result.');
  if (isRecord(payload.range) && typeof payload.range.start === 'string' && typeof payload.range.end === 'string') {
    entries.push(`Range  ${visible(payload.range.start)} to ${visible(payload.range.end)}`);
  }
  return `${entries.join('\n\n')}\n`;
}
