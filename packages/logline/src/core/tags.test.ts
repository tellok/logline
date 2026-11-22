import { describe, expect, it } from 'vitest';
import { getLoglineConfig, removeTag, resetLoglineConfig, setTag, setTags } from './state';
import { mergeTags, normalizeTags } from './utils';

describe('imperative tag management', () => {
  it('sets, merges and removes global tags without replacing other configuration', () => {
    resetLoglineConfig();
    expect(getLoglineConfig().tags).toBeUndefined();

    setTag('app', 'shop');
    expect(getLoglineConfig().tags).toEqual({ app: 'shop' });

    setTags({ env: 'prod', app: 'mall' });
    expect(getLoglineConfig().tags).toEqual({ app: 'mall', env: 'prod' });

    removeTag('app');
    removeTag('absent');
    expect(getLoglineConfig().tags).toEqual({ env: 'prod' });

    removeTag('env');
    expect(getLoglineConfig().tags).toBeUndefined();
    resetLoglineConfig();
  });

  it('applies the same validation and masking as configuration tags', () => {
    resetLoglineConfig();
    setTag('bad key', 'dropped');
    setTag('password', 'fixture-secret');
    expect(getLoglineConfig().tags).toEqual({ password: '***' });
    resetLoglineConfig();
  });
});

describe('normalizeTags', () => {
  it('keeps flat string pairs with queryable keys', () => {
    expect(normalizeTags({ app: 'shop', env_2: 'prod-eu' })).toEqual({ app: 'shop', env_2: 'prod-eu' });
  });

  it('drops invalid keys, empty values and non-string values without enumerating accessors', () => {
    const evil = Object.defineProperty({ ok: 'yes' }, 'trap', {
      enumerable: true,
      get() {
        throw new Error('accessor invoked');
      },
    });
    const input: Record<string, unknown> = {
      '1bad': 'leading digit',
      'bad key': 'space',
      empty: '',
      count: 3,
      nothing: null,
      ok: 'yes',
    };
    expect(normalizeTags(input)).toEqual({ ok: 'yes' });
    expect(normalizeTags(evil)).toEqual({ ok: 'yes' });
    expect(normalizeTags('not an object')).toBeUndefined();
    expect(normalizeTags(['a'])).toBeUndefined();
    expect(normalizeTags(null)).toBeUndefined();
    expect(normalizeTags({})).toBeUndefined();
  });

  it('masks sensitive key names and credential-looking values', () => {
    const result = normalizeTags({ password: 'fixture-secret', note: 'token=abcd1234wxyz' });
    expect(result).toEqual({ password: '***', note: 'token=***' });
  });

  it('truncates values and caps the entry count', () => {
    const long = normalizeTags({ blob: 'x'.repeat(300) });
    expect(long?.blob).toHaveLength(256);
    const many: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) many[`k${index}`] = 'v';
    expect(Object.keys(normalizeTags(many) ?? {})).toHaveLength(16);
  });

  it('returns frozen maps', () => {
    const tags = normalizeTags({ app: 'shop' });
    expect(tags && Object.isFrozen(tags)).toBe(true);
  });

  it('never throws on hostile inputs such as throwing Proxies', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap fired');
        },
      },
    );
    expect(normalizeTags(hostile)).toBeUndefined();
    expect(() => {
      resetLoglineConfig();
      setTags(hostile);
    }).not.toThrow();
    expect(getLoglineConfig().tags).toBeUndefined();
    resetLoglineConfig();
  });
});

describe('mergeTags', () => {
  it('lets per-record entries win and survive the cap ahead of global extras', () => {
    const base: Record<string, string> = {};
    for (let index = 0; index < 16; index += 1) base[`g${index}`] = 'global';
    const merged = mergeTags(base, { g0: 'record', extra: 'here' });
    expect(merged?.g0).toBe('record');
    expect(merged?.extra).toBe('here');
    expect(Object.keys(merged ?? {})).toHaveLength(16);
    expect(merged?.g15).toBeUndefined();
  });

  it('passes through either side when the other is absent', () => {
    const base = normalizeTags({ app: 'shop' });
    expect(mergeTags(base, undefined)).toBe(base);
    expect(mergeTags(undefined, base)).toBe(base);
    expect(mergeTags(undefined, undefined)).toBeUndefined();
  });
});
