interface ImportMetaEnvLike {
  readonly env?: Record<string, unknown>;
}

interface ProcessEnvLike {
  readonly env?: Record<string, unknown>;
}

/**
 * Read boolean or string variables from import.meta.env with a safe fallback.
 * @param key Environment variable name.
 */
const readImportMetaEnv = (key: string): string | boolean | undefined => {
  try {
    if (typeof import.meta === 'undefined') return undefined;
    const meta = import.meta as ImportMeta & ImportMetaEnvLike;
    const envValue = meta.env?.[key];
    if (typeof envValue === 'string' || typeof envValue === 'boolean') return envValue;
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read boolean or string variables from the Node process environment.
 * @param key Environment variable name.
 */
const readProcessEnv = (key: string): string | boolean | undefined => {
  if (typeof process === 'undefined') return undefined;
  const envValue = (process as ProcessEnvLike).env?.[key];
  if (typeof envValue === 'string' || typeof envValue === 'boolean') return envValue;
  return undefined;
};

/**
 * Read environment values from import.meta, then process.
 * @param key Environment variable name.
 */
const readEnvFlag = (key: string): string | boolean | undefined => {
  const fromImportMeta = readImportMetaEnv(key);
  if (fromImportMeta !== undefined) return fromImportMeta;
  return readProcessEnv(key);
};

/**
 * Detect development mode in Vite and Node environments.
 */
export const isDevEnv = (): boolean => {
  const devFlag = readEnvFlag('DEV');
  if (devFlag === true || devFlag === 'true') return true;
  const modeFlag = readEnvFlag('MODE');
  if (modeFlag === 'development') return true;
  const nodeEnv = readEnvFlag('NODE_ENV');
  return nodeEnv === 'development';
};

/**
 * Detect test mode to silence log output automatically.
 */
export const isTestEnv = (): boolean => {
  const vitestFlag = readEnvFlag('VITEST');
  if (vitestFlag === true || vitestFlag === 'true') return true;
  const nodeEnv = readEnvFlag('NODE_ENV');
  return nodeEnv === 'test';
};
