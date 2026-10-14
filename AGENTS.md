# Logline v2 contributor instructions

- The default branch maintains v2 beta. Preserve `v1` for v1 maintenance.
- Use English for communication, source code, comments, diagnostics, tests, and commit messages.
- Keep the default README and documentation in English and provide linked Simplified Chinese versions.
- Keep TypeScript strict. Do not introduce explicit any or unsafe unknown assertions; use type guards and undefined for internal optional values.
- Document core behavior, parameters, return values, and side effects in English.
- Run `pnpm run type-check`, then scoped ESLint fixes, tests, formatting, `pnpm pack`, and `node scripts/check-package.mjs` before pushing. Version PR preparation must not build or publish the product.
- Update README, documentation, and the bundled consumer Skill when behavior or public APIs change.
- Experimental npm versions must use a 2.x beta version and the beta tag. Keep latest on the newest published v1 subversion.

## Public repository privacy

- Use a GitHub noreply email for both author and committer identity; verify both before pushing. Version PR preparation must not build or publish the product.
- Do not include private repository names or source revision identifiers, internal service details, credentials, or personal machine paths in public files.
- Build test fixtures from clearly synthetic values instead of copying identifiers or payloads from real environments.
