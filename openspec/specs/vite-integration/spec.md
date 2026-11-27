# Vite integration

## Purpose

Define build-time controls, source attribution, and optional application integration for supported Vite consumers. See the [Vite and auto-import guide](../../../README.md#vite-integration).

## Requirements

### Requirement: Control recognized log calls in production builds

The Vite plugin SHALL resolve `enable` and minimum `level` from explicit options, process environment, then Vite environment files, defaulting to enabled and `LOG`. When enabled, production transforms SHALL mark recognized calls below the minimum level as pure for removal by the bundler.

#### Scenario: Disable build-time logging

- **WHEN** a production build resolves `enable` to false
- **THEN** the build erases statically recognized calls at all five levels in the application and bundled dependencies, including evaluation of their arguments.
- **AND** dynamic logger calls and native console calls remain outside the filter.

### Requirement: Attribute log sources

The prefix macro SHALL add source hints to supported string and template-literal calls when enabled. The default macro SHALL use the nearest named function and available sourcemaps. Application code MAY use a configured namespace. Dependency attribution SHALL use the installed package name and published artifact location.

#### Scenario: Process optimized dependencies in development

- **WHEN** Vite optimizes dependencies in development
- **THEN** the plugin applies dependency attribution through esbuild on Vite 5–7 and Rolldown on Vite 8.

### Requirement: Opt in to application integrations

The Vite plugin SHALL support injecting automatic IndexedDB initialization through a bundled import and separately enabling HTML startup capture. Both SHALL be disabled by default. Logline SHALL export optional auto-import integration for the five logger names.

#### Scenario: Resolve persistence for a deployment subpath

- **WHEN** an application enables automatic persistence and configures a Vite base
- **THEN** the injected initialization passes the resolved base through to database naming.
