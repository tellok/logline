import { afterEach, describe, expect, test, vi } from 'vitest';
import { HTML_INTEROP_DETACH_KEY, type HtmlInteropDetach } from '../html-interop/html-interop-shared';
import { configureLogline } from './config';
import { DEBUG, ERROR, LOG, TRACE, WARN } from './logger';

describe('Logline runtime preserves HTML capture', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, HTML_INTEROP_DETACH_KEY);
  });

  test('configuration and normal logging do not stop capture early', () => {
    const detach = vi.fn<HtmlInteropDetach>();
    (globalThis as { [HTML_INTEROP_DETACH_KEY]?: HtmlInteropDetach })[HTML_INTEROP_DETACH_KEY] = detach;

    configureLogline({});
    TRACE('trace');
    DEBUG('debug');
    LOG('log');
    WARN('warn');
    ERROR('error');

    expect(detach).not.toHaveBeenCalled();
  });
});
