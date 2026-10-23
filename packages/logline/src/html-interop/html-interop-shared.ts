import { type LogTimestamp } from '../core/config';
import { type LogLevelName } from '../core/constants';

export const HTML_INTEROP_GLOBAL_KEY = '__LOGLINE_HTML_INTEROP__';
export const HTML_INTEROP_FLUSH_KEY = '__LOGLINE_HTML_INTEROP_FLUSH__';
export const HTML_INTEROP_PEEK_KEY = '__LOGLINE_HTML_INTEROP_PEEK__';
export const HTML_INTEROP_DETACH_KEY = '__LOGLINE_HTML_INTEROP_DETACH__';
export const HTML_INTEROP_RESTORE_CONSOLE_KEY = '__LOGLINE_HTML_INTEROP_RESTORE_CONSOLE__';

export interface HtmlInteropRecord {
  readonly id: string;
  readonly level: LogLevelName;
  readonly args: readonly unknown[];
  readonly formattedArgs: readonly unknown[];
  readonly scope?: string;
  readonly messageText?: string;
  readonly messageArgs: readonly unknown[];
  readonly timestamp: LogTimestamp;
}

export interface HtmlInteropState {
  readonly records: HtmlInteropRecord[];
  detached: boolean;
  consoleBackup?: Partial<Record<'debug' | 'log' | 'warn' | 'error', (...args: unknown[]) => void>>;
  errorHandler?: (event: ErrorEvent) => void;
  rejectionHandler?: (event: PromiseRejectionEvent) => void;
}

export type HtmlInteropFlush = () => Promise<readonly HtmlInteropRecord[]>;
export type HtmlInteropPeek = () => Promise<readonly HtmlInteropRecord[]>;
export type HtmlInteropDetach = () => void;

declare global {
  interface Window {
    [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState;
    [HTML_INTEROP_FLUSH_KEY]?: HtmlInteropFlush;
    [HTML_INTEROP_PEEK_KEY]?: HtmlInteropPeek;
    [HTML_INTEROP_DETACH_KEY]?: HtmlInteropDetach;
    [HTML_INTEROP_RESTORE_CONSOLE_KEY]?: HtmlInteropDetach;
  }

  interface Global {
    [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState;
    [HTML_INTEROP_FLUSH_KEY]?: HtmlInteropFlush;
    [HTML_INTEROP_PEEK_KEY]?: HtmlInteropPeek;
    [HTML_INTEROP_DETACH_KEY]?: HtmlInteropDetach;
    [HTML_INTEROP_RESTORE_CONSOLE_KEY]?: HtmlInteropDetach;
  }

  interface GlobalThis {
    [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState;
    [HTML_INTEROP_FLUSH_KEY]?: HtmlInteropFlush;
    [HTML_INTEROP_PEEK_KEY]?: HtmlInteropPeek;
    [HTML_INTEROP_DETACH_KEY]?: HtmlInteropDetach;
    [HTML_INTEROP_RESTORE_CONSOLE_KEY]?: HtmlInteropDetach;
  }
}

/**
 * Stop startup capture while retaining records for later plugin consumption.
 */
export const detachHtmlInteropCapture = (): void => {
  if (typeof globalThis === 'undefined') return;
  const detach = (globalThis as { [HTML_INTEROP_DETACH_KEY]?: HtmlInteropDetach })[HTML_INTEROP_DETACH_KEY];
  detach?.();
};
