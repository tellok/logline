# Click logging plugin

[简体中文](./click-log.zh-CN.md) | [README](../README.md)

Import from `logline/plugin/click-log`.

```ts
import { configureLogline } from 'logline';
import { createClickLogPlugin } from 'logline/plugin/click-log';

configureLogline({ plugins: [createClickLogPlugin()] });
```

`createClickLogPlugin()` returns a Logline plugin that installs a browser event listener. Windows and Intel Macintosh user agents use `click`; other platforms use `touchstart`, preserving the migrated event selection. Installation outside a browser does nothing.

The listener searches ancestors for an element with an ID or class and records its selector and text. Alphanumeric text of at least ten characters containing both letters and digits is replaced with `*`; longer visible text is truncated to ten characters plus `...`. This is a limited heuristic, not a general sensitive-data filter.

Install this plugin once per page; it currently has no disposal API.
