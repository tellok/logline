import { LOG_LEVELS, LOGLINE_MODULE_ID, type LogLevelName } from './core/constants';

export interface AutoImportDescriptor {
  readonly name: string;
  readonly from: string;
}

export type AutoImportResolver = (name: string) => AutoImportDescriptor | undefined;

const isSupportedLogName = (name: string): name is LogLevelName => {
  return LOG_LEVELS.some((level) => level === name);
};

/**
 * Resolve auto-import sources for log functions such as TRACE and DEBUG.
 * @param name Identifier being resolved.
 */
export const loglineAutoImportResolver: AutoImportResolver = (name) => {
  if (isSupportedLogName(name)) {
    return {
      name,
      from: LOGLINE_MODULE_ID,
    };
  }
  return undefined;
};

export const loglineAutoImportResolvers: readonly AutoImportResolver[] = [loglineAutoImportResolver];

/**
 * Return configuration directly usable by unplugin-auto-import.
 */
export const createLoglineAutoImport = (): {
  resolvers: AutoImportResolver[];
  imports: Record<string, LogLevelName[]>;
} => {
  return {
    resolvers: [...loglineAutoImportResolvers],
    imports: {
      [LOGLINE_MODULE_ID]: [...LOG_LEVELS],
    },
  };
};
