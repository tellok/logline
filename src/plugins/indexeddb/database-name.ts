export const DEFAULT_DB_NAME = 'logline';

declare const __LOGLINE_VITE_BASE_URL__: string | undefined;
declare const __LOGLINE_RUNTIME_VITE_BASE_URL__: string | undefined;

const DYNAMIC_BASE_PLACEHOLDER_PATTERN = /(?:^|\/)__[^/]+__(?:\/|$)/;
const URL_RESOLUTION_ORIGIN = 'https://logline.invalid';

/**
 * Read the Vite base injected by loglineVitePlugin during development or builds.
 * @returns Undefined if the plugin was not used or the marker was not replaced.
 */
const readInjectedViteBase = (): string | undefined => {
  try {
    if (typeof __LOGLINE_VITE_BASE_URL__ === 'undefined') return undefined;
    return typeof __LOGLINE_VITE_BASE_URL__ === 'string' ? __LOGLINE_VITE_BASE_URL__ : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read import.meta.env.BASE_URL as a fallback when loglineVitePlugin is not enabled.
 * @returns Undefined outside Vite or for invalid values.
 */
const readRuntimeViteBase = (): string | undefined => {
  try {
    if (typeof __LOGLINE_RUNTIME_VITE_BASE_URL__ === 'undefined') return undefined;
    return typeof __LOGLINE_RUNTIME_VITE_BASE_URL__ === 'string' ? __LOGLINE_RUNTIME_VITE_BASE_URL__ : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Normalize Vite base into a stable path namespace.
 * @param base Configured or runtime Vite base.
 * @returns Slash for root paths, undefined for dynamic placeholders or invalid input.
 */
export const normalizeViteBasePath = (base: string | undefined): string | undefined => {
  const trimmedBase = base?.trim();
  if (!trimmedBase) return undefined;

  try {
    const pathname = new URL(trimmedBase, URL_RESOLUTION_ORIGIN).pathname.replace(/\/{2,}/g, '/');
    if (DYNAMIC_BASE_PLACEHOLDER_PATTERN.test(pathname)) return undefined;
    if (pathname === '/') return pathname;
    return pathname.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
};

/**
 * Resolve database names from explicit configuration, injected base, runtime base, then the default.
 * @param databaseName Explicit database name, preserved as provided.
 * @param injectedViteBase Injected Vite base, read from the internal marker by default.
 * @param runtimeViteBase Runtime Vite base, read from import.meta.env.BASE_URL by default.
 */
export const resolveIndexedDBDatabaseName = (
  databaseName: string | undefined,
  injectedViteBase = readInjectedViteBase(),
  runtimeViteBase = readRuntimeViteBase(),
): string => {
  if (databaseName !== undefined) return databaseName;

  const basePath = normalizeViteBasePath(injectedViteBase) ?? normalizeViteBasePath(runtimeViteBase);
  if (!basePath || basePath === '/') return DEFAULT_DB_NAME;
  return `${DEFAULT_DB_NAME}:${basePath}`;
};
