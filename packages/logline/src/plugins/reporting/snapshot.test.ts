import { describe, expect, it, vi } from 'vitest';
import type { LogRecord } from '../../core/types';
import { createSnapshot } from './snapshot';

const timestamp = { epochMs: 1700000000000, sequence: 3, stableTimeMs: 1700000000000.25 };
const record = (formattedArgs: unknown[], patch: Partial<LogRecord> = {}): LogRecord => ({
  level: 'WARN',
  args: formattedArgs,
  messageArgs: formattedArgs.slice(1),
  formattedArgs,
  timestamp,
  ...patch,
});

describe('reporting intake snapshot', () => {
  it('retains formatted source prefix, sanitized template, stable identity and exact wire bytes', () => {
    const result = createSnapshot(
      record(['[example:7] 付款🧾 42'], { messageText: '[example:7] 付款🧾 %d', messageArgs: [42] }),
      'delivery-A',
    );
    expect(result?.event).toEqual({
      id: 'delivery-A',
      timestamp: timestamp.epochMs,
      level: 'WARN',
      message: '[example:7] 付款🧾 42',
      fields: { ...timestamp, template: '[example:7] 付款🧾 %d' },
    });
    expect(result?.bytes).toBe(Buffer.byteLength(JSON.stringify(result?.event), 'utf8'));
    expect(createSnapshot(record(['second']), 'delivery-B')?.event.id).toBe('delivery-B');
  });

  it('copies flat record tags, masks sensitive keys and drops empty results', () => {
    const tagged = createSnapshot(
      record(['tagged'], { tags: { app: 'shop', password: 'fixture-secret', 'bad key': 'dropped' } }),
      'tagged-A',
    )?.event;
    expect(tagged?.tags).toEqual({ app: 'shop', password: '***' });
    expect(tagged?.tags && Object.isFrozen(tagged.tags)).toBe(true);
    const untagged = createSnapshot(record(['plain'], { tags: {} }), 'tagged-B')?.event;
    expect(untagged).not.toHaveProperty('tags');
    const accessor = createSnapshot(
      record(['trap'], {
        tags: Object.defineProperty({}, 'boom', {
          enumerable: true,
          get() {
            throw new Error('invoked');
          },
        }),
      }),
      'tagged-C',
    )?.event;
    expect(accessor).not.toHaveProperty('tags');
  });

  it('re-cleans tags supplied by a transform', () => {
    const e = createSnapshot(record(['plain']), 'tagged-D', undefined, (event) => ({
      ...event,
      tags: { release: '2.0.0-beta.1', token: 'fixture' },
    }))?.event;
    expect(e?.tags).toEqual({ release: '2.0.0-beta.1', token: '***' });
  });

  it('redacts a project key inside a DSN and does not capture service as built-in metadata', () => {
    const key = `llpk_${'x'.repeat(43)}`;
    const event = createSnapshot(record([`destination https://${key}@telemetry.example.org/project`]), 'dsn', {
      service: 'omitted-source',
      release: `key ${key}`,
    })?.event;
    expect(event?.message).toContain('https://***@telemetry.example.org/project');
    expect(event?.context).not.toHaveProperty('service');
    expect(JSON.stringify(event)).not.toContain(key);
  });

  it('detaches and deeply freezes nested values, sanitized errors and explicit context at intake', () => {
    const error = new TypeError('synthetic failure');
    Object.defineProperty(error, 'stack', { value: 'TypeError: token=fixture\n    at demo:7' });
    const detail = { nested: { value: 1, password: 'fixture', customAttribute: ['first'] } };
    const context = {
      environment: 'test',
      traceId: 'synthetic-trace',
      sessionId: 'synthetic-session',
      session: 'fixture',
      data: [detail],
    };
    const e = createSnapshot(
      record(['[scope]', 'unable to finish', error, detail], { scope: '[scope]' }),
      'one',
      context,
      undefined,
      ['customAttribute'],
    )?.event;
    detail.nested.value = 2;
    detail.nested.customAttribute.push('second');
    context.environment = 'changed';
    expect(e?.fields?.arguments).toEqual([
      { name: 'TypeError', message: 'synthetic failure', stack: 'TypeError: token=***\n    at demo:7' },
      { nested: { value: 1, password: '***', customAttribute: ['first'] } },
    ]);
    expect(e?.message).toBe('[scope] unable to finish');
    expect(e?.context).toMatchObject({
      environment: 'test',
      session: '***',
      traceId: 'synthetic-trace',
      sessionId: 'synthetic-session',
    });
    expect(JSON.stringify(e)).not.toContain('fixture');
    expect(JSON.stringify(e)).not.toContain('second');
    expect(Object.isFrozen(e?.fields?.arguments)).toBe(true);
    expect(Object.isFrozen(e?.context?.data)).toBe(true);
  });

  it('does not reintroduce masked placeholder operands, raw messages, throttle keys or bearer suffixes', () => {
    const e = createSnapshot(
      record(['[demo] Authorization: *** fixture-tail', 'fixture-remaining'], {
        key: 'fixture-key',
        messageText: '[demo] Authorization: Bearer %s',
        args: ['[demo] Authorization: Bearer %s', 'fixture-raw'],
        messageArgs: ['fixture-raw'],
      }),
      'one',
      { release: 'Bearer fixture-token password="fixture words"' },
    )?.event;
    expect(e?.message).toBe('[demo] Authorization: ***');
    expect(e?.fields?.arguments).toBe('***');
    expect(e?.context?.release).toBe('Bearer *** password=***');
    expect(JSON.stringify(e)).not.toContain('fixture');
    const json = createSnapshot(record(['payload={"password": "fixture", "other": 1}']), 'one');
    expect(json?.event.message).not.toContain('fixture');
    for (const args of [
      ['diagnostic', 'Authorization:', 'fixture'],
      ['Bearer', 'fixture'],
      ['password:\nfixture'],
      ['long'.repeat(50_000) + ' token:', 'fixture'],
    ]) {
      const snapshot = createSnapshot(record(args), 'split');
      expect(snapshot).toBeDefined();
      expect(JSON.stringify(snapshot)).not.toContain('fixture');
    }
  });

  it('never enumerates broad objects, calls getters or serializers, or walks arbitrarily large arrays', () => {
    const fail = vi.fn((): never => {
      throw new Error('unexpected');
    });
    const descriptor = vi.fn(Reflect.getOwnPropertyDescriptor);
    const obj = new Proxy(
      {
        get value() {
          return fail();
        },
        toJSON: fail,
        custom: true,
      },
      { ownKeys: fail, get: fail, getOwnPropertyDescriptor: descriptor },
    );
    const many: unknown[] = [obj];
    many[10_000_000] = 'outside budget';
    Object.defineProperty(many, '16', { get: fail });
    const e = createSnapshot(record(['data', many]), 'one', {}, undefined, ['custom'])?.event;
    expect(JSON.stringify(e)).toContain('"custom":true');
    expect(JSON.stringify(e)).toContain('[Accessor]');
    expect(JSON.stringify(e)).toContain('[Truncated]');
    expect(descriptor.mock.calls.length).toBeLessThan(80);
    expect(fail).not.toHaveBeenCalled();
  });

  it('bounds depth, input strings and visited nodes across a branching payload; omits unselected fields', () => {
    const calls = vi.fn(Reflect.getOwnPropertyDescriptor);
    const child = new Proxy({ value: '界'.repeat(500_000), unknownField: 9 }, { getOwnPropertyDescriptor: calls });
    const tree = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => child));
    const deep = { data: { data: { data: { data: { name: 'unreachable' } } } } };
    const result = createSnapshot(record(['large', deep, tree]), 'one');
    expect(result).toBeDefined();
    expect(result?.bytes).toBeLessThan(32_768);
    expect(JSON.stringify(result)).not.toContain('unknownField');
    expect(JSON.stringify(result)).not.toContain('unreachable');
    expect(JSON.stringify(result)).toContain('[Truncated]');
    expect(calls.mock.calls.length).toBeLessThan(4_000);
  });

  it('marks cycles, exotic values and inaccessible objects without dropping other arguments', () => {
    const cyclic: { data?: object } = {};
    cyclic.data = cyclic;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const e = createSnapshot(
      record(['event', cyclic, revoked.proxy, 1n << 9999n, Symbol('opaque'), () => undefined, NaN, 'safe']),
      'one',
    )?.event;
    expect(e?.fields?.arguments).toEqual([
      { data: '[Circular]' },
      '[Unavailable]',
      '[Unsupported]',
      '[Unsupported]',
      '[Unsupported]',
      null,
      'safe',
    ]);
  });

  it('sanitizes transform output again while pinning ID, level and all original time components', () => {
    const external = { secret: 'fixture', custom: ['before'] };
    const time = { ...timestamp };
    const e = createSnapshot(
      record(['start'], { timestamp: time }),
      'one',
      undefined,
      (event) => {
        expect(Object.isFrozen(event)).toBe(true);
        time.sequence = 50;
        return {
          id: 'changed',
          level: 'ERROR',
          timestamp: 0,
          message: 'updated token="fixture"',
          fields: { sequence: 0, data: external },
          context: { environment: 'test', password: 'fixture' },
        };
      },
      ['custom'],
    )?.event;
    external.custom[0] = 'after';
    expect(e).toMatchObject({
      id: 'one',
      level: 'WARN',
      timestamp: timestamp.epochMs,
      message: 'updated token=***',
      fields: { ...timestamp, data: { secret: '***', custom: ['before'] } },
      context: { password: '***' },
    });
    expect(JSON.stringify(e)).not.toContain('fixture');
    expect(Object.isFrozen(e?.fields?.data)).toBe(true);
  });

  it('fails closed on transform failure, opt-out or invalid timestamps; unrelated events are unaffected', () => {
    const r = record(['normal']);
    expect(
      createSnapshot(r, 'a', undefined, () => {
        throw new Error('synthetic');
      }),
    ).toBeUndefined();
    expect(createSnapshot(r, 'b', undefined, () => undefined)).toBeUndefined();
    expect(createSnapshot({ ...r, timestamp: { ...timestamp, epochMs: NaN } }, 'c')).toBeUndefined();
    expect(createSnapshot(r, 'd')?.event.message).toBe('normal');
  });
});
