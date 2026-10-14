export const LOGLINE_MODULE_ID = process.env.LOGLINE_MODULE_ID || 'logline';

/** Internal base marker replaced by the Vite application build. */
export const LOGLINE_VITE_BASE_MARKER = '__LOGLINE_VITE_BASE_URL__';

/** All supported log level names. */
export const LOG_LEVELS = ['TRACE', 'DEBUG', 'LOG', 'WARN', 'ERROR'] as const;

export type LogLevelName = (typeof LOG_LEVELS)[number];

/** Numeric level priorities; smaller values have lower priority. */
export const LOG_LEVEL_INDEX: Record<LogLevelName, number> = {
  TRACE: 0,
  DEBUG: 1,
  LOG: 2,
  WARN: 3,
  ERROR: 4,
};

export const LOG_LEVEL_SET = new Set<LogLevelName>(LOG_LEVELS);
