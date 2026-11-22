import { describe, expect, it } from 'vitest';
import { resolveScopeTags, withScope } from './scope';
import { mergeTags } from './utils';

describe('withScope', () => {
  it('applies scope tags only during a synchronous callback', () => {
    expect(resolveScopeTags()).toBeUndefined();
    const result = withScope((scope) => {
      scope.setTag('requestId', 'req-1');
      expect(resolveScopeTags()).toEqual({ requestId: 'req-1' });
      scope.setTags({ tenant: 'acme' });
      scope.setTag('requestId', 'req-2');
      scope.removeTag('tenant');
      expect(resolveScopeTags()).toEqual({ requestId: 'req-2' });
      return 42;
    });
    expect(result).toBe(42);
    expect(resolveScopeTags()).toBeUndefined();
  });

  it('detaches the scope when the callback throws', () => {
    expect(() =>
      withScope((scope) => {
        scope.setTag('requestId', 'req-1');
        throw new Error('synthetic');
      }),
    ).toThrow('synthetic');
    expect(resolveScopeTags()).toBeUndefined();
  });

  it('nests scopes with inner entries winning on conflicts', () => {
    withScope((outer) => {
      outer.setTags({ layer: 'outer', shared: 'outer' });
      withScope((inner) => {
        inner.setTag('shared', 'inner');
        expect(resolveScopeTags()).toEqual({ layer: 'outer', shared: 'inner' });
      });
      expect(resolveScopeTags()).toEqual({ layer: 'outer', shared: 'outer' });
    });
    expect(resolveScopeTags()).toBeUndefined();
  });

  it('keeps an async scope until the returned promise settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = withScope(async (scope) => {
      scope.setTag('job', 'nightly');
      await gate;
      return 'finished';
    });
    // The scope remains active while the callback awaits.
    expect(resolveScopeTags()).toEqual({ job: 'nightly' });
    release();
    await expect(done).resolves.toBe('finished');
    expect(resolveScopeTags()).toBeUndefined();
  });

  it('detaches async scopes in completion order, not nesting order', async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const outer = withScope(async (scope) => {
      scope.setTag('lane', 'slow');
      await slow;
    });
    const inner = withScope(async (scope) => {
      scope.setTag('lane', 'fast');
      await Promise.resolve();
    });
    await inner;
    // The inner scope finished first; the outer async scope still holds its tags.
    expect(resolveScopeTags()).toEqual({ lane: 'slow' });
    releaseSlow();
    await outer;
    expect(resolveScopeTags()).toBeUndefined();
  });

  it('drops invalid entries and masks sensitive values like configuration tags', () => {
    withScope((scope) => {
      scope.setTag('bad key', 'dropped');
      scope.setTags({ token: 'fixture', empty: '', layer: 'api' });
      expect(resolveScopeTags()).toEqual({ token: '***', layer: 'api' });
    });
  });

  it('feeds the record merge chain between global and per-call tags', () => {
    withScope((scope) => {
      scope.setTags({ shared: 'scope', scopeOnly: 'yes' });
      const chain = mergeTags(mergeTags({ shared: 'global', globalOnly: 'yes' }, resolveScopeTags()), {
        shared: 'record',
      });
      expect(chain).toEqual({ shared: 'record', scopeOnly: 'yes', globalOnly: 'yes' });
    });
  });
});
