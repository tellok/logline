import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentationRoute, rewriteDocumentationLinks } from './docs-content.mjs';

test('documentation links preserve source-relative and cross-language destinations', () => {
  const sources = new Set(['README.md', 'README.zh-CN.md', 'docs/indexeddb.md', 'docs/indexeddb.zh-CN.md']);
  assert.equal(documentationRoute('README.zh-CN.md'), 'zh/index.md');
  assert.equal(
    rewriteDocumentationLinks(
      '[English](../README.md) [中文](../README.zh-CN.md) [English guide](./indexeddb.md#storage)',
      'docs/indexeddb.zh-CN.md',
      sources,
    ),
    '[English](../../index.md) [中文](../index.md) [English guide](../../docs/indexeddb.md#storage)',
  );
  assert.equal(
    rewriteDocumentationLinks('[Guide](./docs/indexeddb.zh-CN.md)', 'README.zh-CN.md', sources),
    '[Guide](docs/indexeddb.md)',
  );
  const unchanged = '[GitHub](https://github.com/tellok/logline) [Heading](#installation) [Missing](./missing.md)';
  assert.equal(rewriteDocumentationLinks(unchanged, 'README.md', sources), unchanged);
});
