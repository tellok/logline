import { type LogTags } from './types';
import { normalizeTags } from './utils';

/**
 * Mutable view over one withScope activation. Entries validate exactly like
 * configuration tags: invalid keys and empty or non-string values are dropped.
 */
export interface LogScope {
  /**
   * Add or update one tag within this scope.
   */
  setTag(key: string, value: string): void;
  /**
   * Merge several tags into this scope.
   */
  setTags(tags: LogTags): void;
  /**
   * Remove one tag from this scope.
   */
  removeTag(key: string): void;
}

interface ScopeEntry {
  tags: Record<string, string>;
}

// Browsers offer no AsyncLocalStorage; a plain stack covers synchronous scopes.
const scopeStack: ScopeEntry[] = [];

/**
 * Merge all active scopes, outermost first so inner scopes win on conflicts.
 * @returns Active scope tags, or undefined outside any scope.
 */
export const resolveScopeTags = (): LogTags | undefined => {
  if (scopeStack.length === 0) return undefined;
  const merged: Record<string, string> = {};
  for (const entry of scopeStack) Object.assign(merged, entry.tags);
  return Object.keys(merged).length > 0 ? Object.freeze(merged) : undefined;
};

const isThenable = (value: unknown): value is Promise<unknown> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as Promise<unknown>).then === 'function'
  );
};

/**
 * Run a callback with a temporary tag scope, Sentry-style.
 * Records logged inside the callback merge scope tags between global tags and
 * per-call tags; nested scopes apply outer-to-inner. A synchronous callback
 * detaches on return or throw. An async callback keeps its scope until the
 * returned promise settles; concurrent async scopes may share tags because
 * browsers lack AsyncLocalStorage.
 * @param callback Receives the mutable scope and produces the result.
 * @returns The callback result, preserving promise types.
 */
export function withScope<T>(callback: (scope: LogScope) => T): T {
  const entry: ScopeEntry = { tags: {} };
  const scope: LogScope = {
    setTag: (key, value) => {
      const normalized = normalizeTags({ [key]: value });
      if (normalized) Object.assign(entry.tags, normalized);
    },
    setTags: (tags) => {
      const normalized = normalizeTags(tags);
      if (normalized) Object.assign(entry.tags, normalized);
    },
    removeTag: (key) => {
      delete entry.tags[key];
    },
  };
  scopeStack.push(entry);
  const detach = (): void => {
    const index = scopeStack.indexOf(entry);
    if (index >= 0) scopeStack.splice(index, 1);
  };
  try {
    const result = callback(scope);
    if (isThenable(result)) {
      return result.then(
        (value) => {
          detach();
          return value;
        },
        (error: unknown) => {
          detach();
          throw error;
        },
      ) as T;
    }
    detach();
    return result;
  } catch (error) {
    detach();
    throw error;
  }
}
