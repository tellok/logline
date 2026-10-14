import { parse, type ParserPlugin } from '@babel/parser';
import type { default as BabelTraverse, Binding, NodePath } from '@babel/traverse';
import * as traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import { build as esbuild, type Loader, type Plugin as EsbuildPlugin } from 'esbuild';
import MagicString, { type SourceMap as MagicStringSourceMap } from 'magic-string';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js';
import { defineConfig, loadEnv, type IndexHtmlTransformContext, type Plugin, type UserConfig } from 'vite';
import { LOG_LEVELS, LOGLINE_MODULE_ID, LOGLINE_VITE_BASE_MARKER, type LogLevelName } from './core/constants';
import { resolvePureCalls } from './core/logger';
import { type IndexedDBLoggingOptions } from './plugins/indexeddb';

const { dirname, isAbsolute, relative, resolve } = path;
const LOG_LEVEL_ENV_NAME = 'VITE_LOG_LEVEL';
const AUTO_INDEXEDDB_MODULE_ID = 'virtual:logline/auto-indexeddb';
const RESOLVED_AUTO_INDEXEDDB_MODULE_ID = `\0${AUTO_INDEXEDDB_MODULE_ID}`;

export interface LoglineVitePluginOptions {
  /**
   * Minimum build-time level, case-insensitive; lower-level calls are removed.
   * Resolve this option first, then process VITE_LOG_LEVEL, merged Vite .env files, and finally LOG.
   * @default 'LOG'
   */
  readonly level?: LogLevelName | string;
  /**
   * Inject a startup script into index.html to buffer console output and errors before the application starts.
   */
  readonly htmlInterop?:
    | boolean
    | {
        readonly src?: string;
        /**
         * Insertion position; head-prepend captures startup failures as early as possible.
         */
        readonly position?: 'head-prepend' | 'head-append';
        /**
         * Inline the startup script in HTML; defaults to true.
         */
        readonly inline?: boolean;
        /**
         * Inline script compilation target; defaults to es2016.
         */
        readonly esbuildTarget?: string;
      };
  /**
   * Automatically install IndexedDB from the Vite application entry; disabled by default.
   * An object supplies options to createIndexedDBLoggingPlugin.
   * Keep disabled in npm libraries; the consuming application owns browser persistence.
   * @default false
   */
  readonly indexedDB?: boolean | IndexedDBLoggingOptions;
  /**
   * Inject source locations and function names for calls whose first argument is a string.
   * @default true
   */
  readonly logPrefixMacro?:
    | boolean
    | {
        /**
         * Include function names; defaults to true.
         */
        readonly includeFunctionName?: boolean;
        /**
         * Use sourcemaps; defaults to true.
         * Restore source line and column positions from available sourcemaps.
         * This accounts for earlier transformations such as unplugin-auto-import.
         * Disable to use positions from the current AST instead.
         */
        readonly sourcemapRetrack?: boolean;
        /**
         * Add an application label; npm dependencies always use their installed package.json name.
         */
        readonly namespace?: string;
      };
}

// Vite 6/7/8 support order/handler; extend the fields to accommodate their Plugin definitions.
type OrderablePlugin = Plugin & {
  readonly order?: 'pre' | 'post';
  readonly transformIndexHtml?: {
    readonly order?: 'pre' | 'post';
    readonly handler: (html: string, context?: IndexHtmlTransformContext) => string | Promise<string>;
  };
};

/**
 * Normalize an external level string into a supported level.
 * @param level Configured level string.
 */
const normalizeLevel = (level?: LogLevelName | string): LogLevelName | undefined => {
  if (!level) return undefined;
  const upper = typeof level === 'string' ? level.toUpperCase() : level;
  return LOG_LEVELS.find((candidate) => candidate === upper);
};

type LogLevelSource = 'option' | 'process-env' | 'project-env' | 'default';

interface LogLevelCandidate {
  readonly source: LogLevelSource;
  readonly value?: LogLevelName | string;
}

interface LogLevelResolution {
  readonly level: LogLevelName;
  readonly source: LogLevelSource;
  readonly rawValue: string;
}

/**
 * Resolve the build level from candidates in priority order.
 * @param candidates Level candidates ordered from highest to lowest priority.
 */
const resolveLogLevel = (candidates: readonly LogLevelCandidate[]): LogLevelResolution => {
  for (const candidate of candidates) {
    const normalized = normalizeLevel(candidate.value);
    if (normalized) {
      return {
        level: normalized,
        rawValue: String(candidate.value),
        source: candidate.source,
      };
    }
  }
  return {
    level: 'LOG',
    rawValue: 'LOG',
    source: 'default',
  };
};

/**
 * Read project environment files with loadEnv without inheriting process values for the same key.
 * @param mode Current Vite mode.
 * @param envDir Vite environment file directory.
 */
const loadProjectEnvLogLevel = (mode: string, envDir: string): string | undefined => {
  const hasProcessValue = Object.prototype.hasOwnProperty.call(process.env, LOG_LEVEL_ENV_NAME);
  const processValue = process.env[LOG_LEVEL_ENV_NAME];
  if (hasProcessValue) {
    delete process.env[LOG_LEVEL_ENV_NAME];
  }
  try {
    return loadEnv(mode, envDir)[LOG_LEVEL_ENV_NAME];
  } finally {
    if (hasProcessValue && processValue !== undefined) {
      process.env[LOG_LEVEL_ENV_NAME] = processValue;
    }
  }
};

/**
 * Resolve the environment directory, defaulting to the Vite project root.
 * @param envDir Configured envDir.
 * @param root Vite project root.
 */
const resolveEnvDir = (envDir: UserConfig['envDir'], root: string): string => {
  if (typeof envDir !== 'string') return root;
  return isAbsolute(envDir) ? envDir : resolve(root, envDir);
};

/**
 * Resolve the Vite root, defaulting to the current working directory.
 * @param root Configured root.
 */
const resolveRoot = (root: UserConfig['root']): string => {
  if (typeof root !== 'string') return process.cwd();
  return isAbsolute(root) ? root : resolve(process.cwd(), root);
};

/**
 * Describe the selected level source for the Vite logger.
 * @param source Level source identifier.
 */
const describeLogLevelSource = (source: LogLevelSource): string => {
  if (source === 'option') return 'loglineVitePlugin({ level })';
  if (source === 'process-env') return `process.env.${LOG_LEVEL_ENV_NAME}`;
  if (source === 'project-env') return `project .env* ${LOG_LEVEL_ENV_NAME}`;
  return 'default';
};

const parserPlugins: readonly ParserPlugin[] = [
  'typescript',
  'jsx',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'decorators-legacy',
  'dynamicImport',
  'importMeta',
  'topLevelAwait',
];

/** Check whether an external module value supports safe property access. */
const isPropertyRecord = (value: unknown): value is Record<PropertyKey, unknown> => {
  return typeof value === 'object' && value !== null;
};

/** Check whether an external export is the Babel traverse function. */
const isBabelTraverse = (value: unknown): value is typeof BabelTraverse => typeof value === 'function';

/**
 * Resolve Babel traverse across ESM, CommonJS, and nested default exports.
 * @returns Callable traverse function, or undefined when unavailable.
 */
const resolveBabelTraverse = (): typeof BabelTraverse | undefined => {
  const moduleValue: unknown = traverseModule;
  if (isBabelTraverse(moduleValue)) return moduleValue;
  if (!isPropertyRecord(moduleValue)) return undefined;

  const defaultValue = moduleValue.default;
  if (isBabelTraverse(defaultValue)) return defaultValue;
  if (isPropertyRecord(defaultValue) && isBabelTraverse(defaultValue.default)) return defaultValue.default;

  const namedValue = moduleValue.traverse;
  return isBabelTraverse(namedValue) ? namedValue : undefined;
};

const CALL_MACRO_NAMES = new Set<string>(LOG_LEVELS);
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|vue)(?:$|\?)/;
const OPTIMIZE_DEPS_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/;
const GENERATED_NPM_PREFIX_PATTERN = /^\[npm:([^\s\]]+)\s+([^\]]+?:\d+(?::\d+)?(?:\s+[^\]]+)?)\]\s*/;

interface PackageManifestLocation {
  readonly name: string;
  readonly root: string;
}

interface ModuleLocation {
  readonly artifactPath: string;
  readonly packageName?: string;
}

/**
 * Read a valid package name from package.json.
 * @param packageJsonPath Absolute package.json path.
 * @returns Undefined if the name is invalid or the manifest cannot be read.
 */
const readPackageName = (packageJsonPath: string): string | undefined => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('name' in manifest)) return undefined;
    return typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Locate the nearest npm package and derive an artifact path relative to its root.
 * @param initialProjectRoot Vite project root.
 */
const createModuleLocationResolver = (initialProjectRoot: string) => {
  const manifestCache = new Map<string, PackageManifestLocation | false>();
  const moduleCache = new Map<string, ModuleLocation>();
  let projectRoot = resolve(initialProjectRoot);
  let projectPackageRoot: string | undefined;

  const findNearestPackage = (fileOrDirectory: string): PackageManifestLocation | undefined => {
    const absolutePath = resolve(fileOrDirectory);
    const directory =
      existsSync(absolutePath) && statSync(absolutePath).isDirectory() ? absolutePath : dirname(absolutePath);
    let currentDirectory = directory;
    const visited: string[] = [];
    while (true) {
      const cached = manifestCache.get(currentDirectory);
      if (cached !== undefined) {
        const result = cached || undefined;
        for (const item of visited) manifestCache.set(item, cached);
        return result;
      }
      visited.push(currentDirectory);
      const packageJsonPath = resolve(currentDirectory, 'package.json');
      if (existsSync(packageJsonPath)) {
        const name = readPackageName(packageJsonPath);
        if (name) {
          const result = { name, root: currentDirectory };
          for (const item of visited) manifestCache.set(item, result);
          return result;
        }
      }
      const parent = dirname(currentDirectory);
      if (parent === currentDirectory) {
        for (const item of visited) manifestCache.set(item, false);
        return undefined;
      }
      currentDirectory = parent;
    }
  };

  const refreshProjectPackageRoot = (): void => {
    projectPackageRoot = findNearestPackage(projectRoot)?.root;
    moduleCache.clear();
  };

  refreshProjectPackageRoot();

  return {
    /**
     * Update the project root from the resolved Vite configuration.
     * @param root Resolved project root.
     */
    setProjectRoot(root: string): void {
      projectRoot = resolve(root);
      refreshProjectPackageRoot();
    },
    /**
     * Resolve package ownership and the display path of a module.
     * @param id Absolute Vite/esbuild module path.
     */
    resolve(id: string): ModuleLocation {
      const cleanId = id.replace(/[?#].*$/, '');
      const cached = moduleCache.get(cleanId);
      if (cached) return cached;
      const packageLocation = cleanId.startsWith('\0') ? undefined : findNearestPackage(cleanId);
      const isDependency = packageLocation && packageLocation.root !== projectPackageRoot;
      const artifactPath = isDependency
        ? normalizePath(relative(packageLocation.root, cleanId))
        : resolveRelativePath(cleanId, projectRoot);
      const result: ModuleLocation = {
        artifactPath,
        packageName: isDependency ? packageLocation.name : undefined,
      };
      moduleCache.set(cleanId, result);
      return result;
    },
  };
};

const normalizeCalleeName = (name: string): string => name.replace(/^_+/, '');

const resolveCalleeName = (callee: t.CallExpression['callee']): string | undefined => {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const prop = callee.property;
    if (t.isIdentifier(prop)) return prop.name;
    if (t.isStringLiteral(prop)) return prop.value;
    return undefined;
  }
  if (t.isSequenceExpression(callee)) {
    const last = callee.expressions.at(-1);
    return resolveCalleeName(last as t.CallExpression['callee']);
  }
  return undefined;
};

const isLoglineCall = (callee: t.CallExpression['callee']): boolean => {
  const name = resolveCalleeName(callee);
  if (!name) return false;
  const normalized = normalizeCalleeName(name);
  // Skip names outside the supported level set.
  if (!CALL_MACRO_NAMES.has(normalized)) return false;
  return true;
};

/**
 * Resolve the actual callee, including SequenceExpression wrappers.
 * @param callee Original callee.
 */
const resolveCallTarget = (callee: t.CallExpression['callee']): t.Expression | undefined => {
  if (t.isSequenceExpression(callee)) {
    const last = callee.expressions.at(-1);
    if (t.isExpression(last)) return last;
    return undefined;
  }
  if (t.isExpression(callee)) return callee;
  return undefined;
};

/**
 * Recognize Logline module IDs, including Rollup CommonJS virtual external modules.
 * @param moduleId Module ID used by import or require.
 */
const isLoglineModuleId = (moduleId: string): boolean => {
  const normalized = moduleId.replace(/^\0/, '').replace(/\?.*$/, '');
  return normalized === LOGLINE_MODULE_ID;
};

/**
 * Check whether an initializer comes from a Logline require or import helper.
 * @param node Variable initializer node.
 */
const isRequireFromLogline = (node: t.Node | null | undefined): boolean => {
  if (!node) return false;
  if (!t.isCallExpression(node)) return false;
  const callee = node.callee;
  const [firstArg] = node.arguments;
  if (t.isIdentifier(callee, { name: 'require' }) && t.isStringLiteral(firstArg)) {
    return isLoglineModuleId(firstArg.value);
  }
  if (
    t.isIdentifier(callee) &&
    (callee.name === '__importStar' || callee.name === '__importDefault') &&
    firstArg &&
    t.isExpression(firstArg)
  ) {
    return isRequireFromLogline(firstArg);
  }
  return false;
};

/**
 * Check whether a binding resolves to a Logline import or require result.
 * @param binding Scope binding.
 * @param visited Previously visited bindings, preventing alias cycles.
 */
const isLoglineBinding = (
  binding: Binding | null | undefined,
  visited: ReadonlySet<Binding> = new Set<Binding>(),
): boolean => {
  if (!binding || visited.has(binding)) return false;
  const nextVisited = new Set(visited).add(binding);
  if (binding.kind === 'module') {
    const parent = binding.path.parent;
    if (t.isImportDeclaration(parent)) {
      return isLoglineModuleId(parent.source.value);
    }
  }
  const declarator = binding.path.isVariableDeclarator()
    ? binding.path
    : binding.path.findParent((parent) => parent.isVariableDeclarator());
  if (declarator?.isVariableDeclarator()) {
    const initializer = declarator.node.init;
    if (isRequireFromLogline(initializer ?? undefined)) return true;
    if (t.isIdentifier(initializer)) {
      return isLoglineBinding(declarator.scope.getBinding(initializer.name), nextVisited);
    }
    if (
      (t.isMemberExpression(initializer) || t.isOptionalMemberExpression(initializer)) &&
      t.isIdentifier(initializer.object)
    ) {
      return isLoglineBinding(declarator.scope.getBinding(initializer.object.name), nextVisited);
    }
  }
  return false;
};

const normalizePath = (p: string): string => p.replace(/\\/g, '/');

/**
 * Check whether a module file belongs to the specified directory.
 * @param id Module ID.
 * @param directory Absolute target directory.
 */
const isModuleInDirectory = (id: string, directory: string): boolean => {
  if (id.startsWith('\0')) return false;
  const cleanId = id.replace(/[?#].*$/, '');
  const relativePath = relative(directory, cleanId);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
};

const resolveRelativePath = (id: string, root: string): string => {
  const clean = id.replace(/[?#].*$/, '');
  const rel = relative(root, clean);
  const normalized = normalizePath(rel || clean);

  const parts = normalized.split('/');
  const filename = parts.at(-1) ?? normalized;

  // Keep two path segments for index entry files.
  if (/^index\.(ts|vue|js|tsx|jsx|mjs|cjs)$/.test(filename)) {
    return parts.slice(-2).join('/');
  }
  // Otherwise keep only the file name.
  return filename;
};

/**
 * Read a displayable function name from an object member or method key.
 * @param key Babel object member or method key.
 */
const resolveFunctionKeyName = (key: t.Node): string | undefined => {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key) || t.isNumericLiteral(key)) return String(key.value);
  if (t.isPrivateName(key)) return `#${key.id.name}`;
  return undefined;
};

/**
 * Find the nearest function name around a log call in the current artifact.
 * @param path AST path of the log call.
 * @returns Undefined for top-level calls or unnamed functions.
 */
const getFunctionName = (path: NodePath): string | undefined => {
  const func = path.getFunctionParent();
  if (!func) return undefined;
  if (func.isFunctionDeclaration() && func.node.id) return func.node.id.name;
  if (func.isFunctionExpression() && func.node.id) return func.node.id.name;
  const parent = func.parentPath;
  if ((func.isFunctionExpression() || func.isArrowFunctionExpression()) && parent) {
    if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return parent.node.id.name;
    if (parent.isAssignmentExpression() && t.isIdentifier(parent.node.left)) return parent.node.left.name;
    if (
      parent.isAssignmentExpression() &&
      (t.isMemberExpression(parent.node.left) || t.isOptionalMemberExpression(parent.node.left))
    ) {
      return resolveFunctionKeyName(parent.node.left.property);
    }
    if (parent.isObjectProperty() || parent.isObjectMethod()) {
      return resolveFunctionKeyName(parent.node.key);
    }
    if (parent.isClassMethod() || parent.isClassPrivateMethod()) {
      return resolveFunctionKeyName(parent.node.key);
    }
  }
  if (func.isObjectMethod() || func.isClassMethod() || func.isClassPrivateMethod()) {
    return resolveFunctionKeyName(func.node.key);
  }
  return undefined;
};

const shouldTransformMacro = (id: string): boolean => {
  // Handle .vue modules after the Vue plugin has compiled them to JavaScript.
  return SOURCE_FILE_PATTERN.test(id);
};

/**
 * Check whether a log call belongs to Logline.
 * @param path Log call path.
 * @param allowUnbound Whether unbound auto-import calls are allowed in application code.
 */
const isValidLoggingImport = (path: NodePath<t.CallExpression>, allowUnbound: boolean): boolean => {
  const targetCallee = resolveCallTarget(path.node.callee);
  if (!targetCallee) return false;

  if (t.isIdentifier(targetCallee)) {
    const binding = path.scope.getBinding(targetCallee.name);
    // Allow unbound auto-imports only in application code; dependencies require an explicit Logline binding.
    if (!binding) return allowUnbound;
    return isLoglineBinding(binding);
  }

  if (t.isMemberExpression(targetCallee) || t.isOptionalMemberExpression(targetCallee)) {
    const obj = targetCallee.object;
    if (t.isIdentifier(obj)) {
      const binding = path.scope.getBinding(obj.name);
      if (!binding) return allowUnbound;
      return isLoglineBinding(binding);
    }
  }

  return false;
};

type PossibleSourceMap = {
  readonly mappings: string;
  readonly names: readonly string[];
  readonly sources: readonly string[];
  readonly version: number | string;
  readonly sourcesContent?: readonly unknown[];
  readonly file?: string;
  readonly sourceRoot?: string;
};

/**
 * Normalize external sourcemaps for SourceMapConsumer.
 * @param map Combined sourcemap.
 */
const normalizeToRawSourceMap = (map: PossibleSourceMap | null | undefined): RawSourceMap | undefined => {
  if (!map) return undefined;
  return {
    file: map.file,
    mappings: map.mappings,
    names: [...map.names],
    sourceRoot: map.sourceRoot,
    sources: [...map.sources],
    // Normalize missing external source content to empty strings for consumer type compatibility.
    sourcesContent: map.sourcesContent?.map((content) => (typeof content === 'string' ? content : '')),
    version: typeof map.version === 'string' ? map.version : String(map.version),
  };
};

interface GeneratedNpmPrefix {
  readonly packageName: string;
  readonly raw: string;
}

/**
 * Read existing npm prefixes to support legacy artifacts and idempotent transformations.
 * @param message First log argument text.
 */
const parseGeneratedNpmPrefixes = (
  message: string,
): { readonly prefixes: readonly GeneratedNpmPrefix[]; readonly rest: string } => {
  const prefixes: GeneratedNpmPrefix[] = [];
  let rest = message;
  while (true) {
    const match = GENERATED_NPM_PREFIX_PATTERN.exec(rest);
    if (!match) break;
    const [raw, packageName] = match;
    if (!packageName) break;
    prefixes.push({ packageName, raw });
    rest = rest.slice(raw.length);
  }
  return { prefixes, rest };
};

/**
 * Normalize dependency prefixes; preserve the innermost original owner when one package bundles another.
 * @param message Original log message.
 * @param prefix New prefix for the current module.
 * @param packageName Package owning the physical module.
 */
const applyNpmPrefix = (message: string, prefix: string, packageName: string): string => {
  const { prefixes, rest } = parseGeneratedNpmPrefixes(message);
  const innermost = prefixes.at(-1);
  if (!innermost || innermost.packageName === packageName) return prefix + rest;
  return innermost.raw + rest;
};

/**
 * Use mapped locations only when they still identify the published artifact rather than author source.
 * @param source Original file returned by the sourcemap.
 * @param artifactPath Published artifact path within the npm package.
 */
const isSameArtifactSource = (source: string | null, artifactPath: string): boolean => {
  if (!source) return false;
  const normalizedSource = normalizePath(source).replace(/^file:\/\//, '');
  return normalizedSource === artifactPath || normalizedSource.endsWith(`/${artifactPath}`);
};

const transformLoggingCode = (
  code: string,
  id: string,
  location: ModuleLocation,
  options: {
    readonly macroEnabled: boolean;
    readonly includeFunctionName: boolean;
    readonly sourcemapRetrack: boolean;
    readonly namespace?: string;
    readonly dropLevelSet: ReadonlySet<LogLevelName>;
  },
  combinedMap?: RawSourceMap,
): { code: string; map: MagicStringSourceMap } | undefined => {
  const needMacro = options.macroEnabled;
  const needStrip = options.dropLevelSet.size > 0;
  if (!needMacro && !needStrip) return undefined;
  let ast: t.File;
  try {
    ast = parse(code, {
      plugins: [...parserPlugins],
      sourceFilename: id,
      sourceType: 'module',
    });
  } catch {
    return undefined;
  }

  const ms = new MagicString(code);
  const relPath = location.artifactPath;
  const isNpmDependency = Boolean(location.packageName);
  let macroMutated = false;
  let stripMutated = false;
  const isVueScript = id.includes('.vue');
  const traverseFn = resolveBabelTraverse();
  if (!traverseFn) return undefined;

  let consumer: SourceMapConsumer | undefined;
  if (needMacro && options.sourcemapRetrack && combinedMap) {
    try {
      consumer = new SourceMapConsumer(combinedMap);
    } catch {
      // ignore
    }
  }

  traverseFn(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      if (!isLoglineCall(path.node.callee)) return;
      const calleeName = resolveCalleeName(path.node.callee);
      if (!calleeName) return;
      const normalizedName = normalizeCalleeName(calleeName);
      const level = LOG_LEVELS.find((item) => item === normalizedName);
      if (!level) return;
      if (!isValidLoggingImport(path, !isNpmDependency)) return;

      if (needStrip && options.dropLevelSet.has(level)) {
        const start = path.node.start;
        const end = path.node.end;
        if (typeof start === 'number' && typeof end === 'number') {
          ms.overwrite(start, end, 'void 0');
          stripMutated = true;
        }
        return;
      }

      if (!needMacro) return;
      const [firstArg] = path.node.arguments;
      if (!firstArg) return;

      // Read dependency function names from the published AST instead of tracing back to author source.
      const fnName = options.includeFunctionName ? getFunctionName(path) : undefined;
      let line = path.node.loc?.start.line;
      let column = path.node.loc ? path.node.loc.start.column + 1 : undefined;

      if (consumer && line && path.node.loc?.start.column !== undefined) {
        const original = consumer.originalPositionFor({
          column: path.node.loc.start.column,
          line,
        });
        const canUseOriginal = !isNpmDependency || isSameArtifactSource(original.source, relPath);
        if (canUseOriginal && typeof original.line === 'number') {
          line = original.line;
        }
        if (canUseOriginal && typeof original.column === 'number') {
          column = original.column + 1;
        }
      }
      const lineSuffix = line ? `:${line}` : '';
      const columnSuffix = line && column ? `:${column}` : '';
      const namespace = location.packageName ? `npm:${location.packageName}` : options.namespace;
      const tagPrefix = namespace ? `${namespace} ` : '';
      const prefix = `[${tagPrefix}${relPath}${lineSuffix}${columnSuffix}${fnName ? ` ${fnName}` : ''}] `;

      if (t.isStringLiteral(firstArg)) {
        const message = location.packageName
          ? applyNpmPrefix(firstArg.value, prefix, location.packageName)
          : prefix + firstArg.value;
        const next = JSON.stringify(message);
        const start = firstArg.start;
        const end = firstArg.end;
        if (typeof start !== 'number' || typeof end !== 'number') return;
        ms.overwrite(start, end, next);
        macroMutated = true;
      } else if (t.isTemplateLiteral(firstArg)) {
        const firstQuasi = firstArg.quasis[0];
        if (firstQuasi && typeof firstQuasi.start === 'number' && typeof firstQuasi.end === 'number') {
          const raw = firstQuasi.value.raw;
          const next = location.packageName ? applyNpmPrefix(raw, prefix, location.packageName) : prefix + raw;
          ms.overwrite(firstQuasi.start, firstQuasi.end, next);
          macroMutated = true;
        }
      }
    },
  });

  if (needMacro && !macroMutated && !stripMutated && isVueScript) {
    const pattern = new RegExp(`\\b(${[...CALL_MACRO_NAMES].join('|')})\\s*\\(\\s*(['"\`])(.*?)\\2`, 'g');
    let fallbackMutated = false;
    ms.replace(pattern, (_match, level: string, quote: string, msg: string) => {
      const namespace = location.packageName ? `npm:${location.packageName}` : options.namespace;
      const tagPrefix = namespace ? `${namespace} ` : '';
      const prefix = `[${tagPrefix}${relPath}] `;
      fallbackMutated = true;
      const next = `${level}(${quote}${prefix}${msg}${quote}`;
      return next;
    });
    if (fallbackMutated) {
      macroMutated = true;
    }
  }
  if (!macroMutated && !stripMutated) return undefined;
  return {
    code: ms.toString(),
    map: ms.generateMap({ hires: true, source: id }),
  };
};

type ModuleLocationResolver = ReturnType<typeof createModuleLocationResolver>;

/**
 * Replace the internal base marker and preserve the module sourcemap.
 * @param code Code to transform.
 * @param id Current module ID.
 * @param viteBase Resolved Vite base.
 */
const transformViteBaseMarker = (
  code: string,
  id: string,
  viteBase: string,
): { readonly code: string; readonly map: MagicStringSourceMap } | undefined => {
  if (!code.includes(LOGLINE_VITE_BASE_MARKER)) return undefined;
  let ast: t.File;
  try {
    ast = parse(code, {
      plugins: [...parserPlugins],
      sourceFilename: id,
      sourceType: 'module',
    });
  } catch {
    return undefined;
  }

  const magicString = new MagicString(code);
  const traverseFn = resolveBabelTraverse();
  if (!traverseFn) return undefined;

  let mutated = false;
  traverseFn(ast, {
    Identifier(path: NodePath<t.Identifier>) {
      if (path.node.name !== LOGLINE_VITE_BASE_MARKER || !path.isReferencedIdentifier()) return;
      const start = path.node.start;
      const end = path.node.end;
      if (typeof start !== 'number' || typeof end !== 'number') return;
      magicString.overwrite(start, end, JSON.stringify(viteBase));
      mutated = true;
    },
  });
  if (!mutated) return undefined;

  return {
    code: magicString.toString(),
    map: magicString.generateMap({ hires: true, includeContent: true, source: id }),
  };
};

/**
 * Select an esbuild loader by extension, preferring the application's configured loaders.
 * @param filePath Dependency file path.
 * @param configuredLoaders Existing extension-to-loader configuration.
 */
const resolveOptimizeDepsLoader = (
  filePath: string,
  configuredLoaders: Readonly<Record<string, Loader>> | undefined,
): Loader => {
  const extension = path.extname(filePath).toLowerCase();
  const configured = configuredLoaders?.[extension];
  if (configured) return configured;
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') return 'ts';
  if (extension === '.tsx') return 'tsx';
  if (extension === '.jsx') return 'jsx';
  return 'js';
};

/**
 * Inject dependency attribution before Vite development prebundling.
 * @param locationResolver Module ownership resolver.
 * @param includeFunctionName Whether dependency prefixes include artifact function names.
 * @param resolveViteBase Function returning the resolved Vite base.
 */
const createOptimizeDepsLoggingPlugin = (
  locationResolver: ModuleLocationResolver,
  includeFunctionName: boolean,
  resolveViteBase: () => string,
): EsbuildPlugin => ({
  name: 'logline-dependency-prefix',
  setup(build) {
    build.onLoad({ filter: OPTIMIZE_DEPS_FILE_PATTERN, namespace: 'file' }, (args) => {
      const location = locationResolver.resolve(args.path);
      if (!location.packageName) return undefined;
      const code = readFileSync(args.path, 'utf8');
      const loggingResult = transformLoggingCode(
        code,
        args.path,
        location,
        {
          dropLevelSet: new Set<LogLevelName>(),
          includeFunctionName,
          macroEnabled: true,
          sourcemapRetrack: false,
        },
        undefined,
      );
      const viteBaseResult = transformViteBaseMarker(loggingResult?.code ?? code, args.path, resolveViteBase());
      if (!loggingResult && !viteBaseResult) return undefined;
      return {
        contents: viteBaseResult?.code ?? loggingResult?.code ?? code,
        loader: resolveOptimizeDepsLoader(args.path, build.initialOptions.loader),
        resolveDir: dirname(args.path),
        watchFiles: [args.path],
      };
    });
  },
});

/**
 * Resolve the startup script import address.
 * @param option Configured script injection options.
 */
const resolveHtmlInteropSrc = (option: LoglineVitePluginOptions['htmlInterop']): string => {
  if (option && typeof option === 'object' && 'src' in option && option.src) return option.src;
  return 'logline/html-interop';
};

// Resolve the current directory from import.meta.url.
const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Insert the startup script at the configured HTML position.
 * @param html Original HTML.
 * @param src Script address.
 * @param position Insertion position.
 */
const injectHtmlInteropScript = (html: string, src: string, position: 'head-prepend' | 'head-append'): string => {
  const scriptTag = `<script type="module" src="${src}"></script>`;
  if (position === 'head-append') {
    return html.replace(/<\/head>/i, `    ${scriptTag}\n</head>`);
  }
  // Prepend early in head to capture startup failures.
  return html.replace(/(<head[^>]*>)/i, `$1\n    ${scriptTag}`);
};

const injectInlineHtmlInterop = (html: string, code: string, position: 'head-prepend' | 'head-append'): string => {
  const scriptTag = `<script>${code}</script>`;
  if (position === 'head-append') {
    return html.replace(/<\/head>/i, `    ${scriptTag}\n</head>`);
  }
  return html.replace(/(<head[^>]*>)/i, `$1\n    ${scriptTag}`);
};

/**
 * Read a named attribute from an HTML attribute string.
 * @param attributes Original script attributes.
 * @param name Attribute name.
 * @returns Undefined if the attribute is absent.
 */
const readHtmlAttribute = (attributes: string, name: 'src' | 'type'): string | undefined => {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = pattern.exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

/**
 * Resolve an HTML module entry into an absolute Vite transform ID.
 * @param source Script src attribute.
 * @param htmlFilename Absolute HTML file path.
 * @param projectRoot Vite project root.
 */
const resolveHtmlModuleEntry = (
  source: string,
  htmlFilename: string | undefined,
  projectRoot: string,
): string | undefined => {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return undefined;
  const cleanSource = source.replace(/[?#].*$/, '');
  if (!cleanSource) return undefined;
  const absolutePath = cleanSource.startsWith('/')
    ? resolve(projectRoot, `.${cleanSource}`)
    : resolve(htmlFilename ? dirname(htmlFilename) : projectRoot, cleanSource);
  return normalizePath(absolutePath);
};

/**
 * Collect external ESM entries so automatic initialization joins their original module graph.
 * @param html HTML before Vite transformation.
 * @param context HTML transformation context.
 * @param projectRoot Vite project root.
 */
const collectHtmlModuleEntries = (
  html: string,
  context: IndexHtmlTransformContext | undefined,
  projectRoot: string,
): readonly string[] => {
  const entries: string[] = [];
  const scriptPattern = /<script\b([^>]*)>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const attributes = match[1] ?? '';
    if (readHtmlAttribute(attributes, 'type')?.toLowerCase() !== 'module') continue;
    const source = readHtmlAttribute(attributes, 'src');
    if (!source) continue;
    const entry = resolveHtmlModuleEntry(source, context?.filename, projectRoot);
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries;
};

const findHtmlInteropEntry = (): string => {
  const candidates = [
    resolve(currentDir, 'html-interop.js'),
    resolve(currentDir, 'html-interop.ts'),
    resolve(currentDir, 'html-interop/html-interop.ts'),
    resolve(currentDir, 'html-interop/html-interop.js'),
    resolve(currentDir, 'src/html-interop/html-interop.ts'),
    resolve(currentDir, 'src/html-interop/html-interop.js'),
  ];
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error('logline: html-interop entry file not found');
  }
  return found;
};

const bundleHtmlInteropInline = async (target: string, minify: boolean): Promise<string> => {
  const entry = findHtmlInteropEntry();
  const result = await esbuild({
    bundle: true,
    entryPoints: [entry],
    format: 'iife',
    minify,
    platform: 'browser',
    target,
    write: false,
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error('logline: inline startup script build failed');
  return output;
};

/**
 * Vite plugin that replaces lower-level calls so the bundler can remove them.
 */
export const loglineVitePlugin = (options: LoglineVitePluginOptions = {}): Plugin | Plugin[] => {
  const enableHtmlInterop = Boolean(options.htmlInterop);
  const enableIndexedDB = Boolean(options.indexedDB);
  const indexedDBOptions = options.indexedDB && typeof options.indexedDB === 'object' ? options.indexedDB : {};
  const htmlInteropSrc = resolveHtmlInteropSrc(options.htmlInterop);
  const htmlInteropPosition =
    options.htmlInterop && typeof options.htmlInterop === 'object' && 'position' in options.htmlInterop
      ? (options.htmlInterop.position ?? 'head-prepend')
      : 'head-prepend';
  const htmlInteropInline =
    options.htmlInterop && typeof options.htmlInterop === 'object' && 'inline' in options.htmlInterop
      ? options.htmlInterop.inline !== false
      : true;
  const htmlInteropTarget =
    options.htmlInterop && typeof options.htmlInterop === 'object' && 'esbuildTarget' in options.htmlInterop
      ? (options.htmlInterop.esbuildTarget ?? 'es2016')
      : 'es2016';
  let inlineCache: Map<string, Promise<string>> | undefined;
  let isBuildCommand = false;
  const macroOption = options.logPrefixMacro;
  const macroEnabled = macroOption !== false;
  const macroIncludeFunctionName =
    typeof macroOption === 'object' && macroOption && macroOption.includeFunctionName === false ? false : true;
  const macroSourcemapRetrack =
    typeof macroOption === 'object' && macroOption && macroOption.sourcemapRetrack === false ? false : true;
  const macroNamespace = typeof macroOption === 'object' && macroOption ? macroOption.namespace : undefined;
  let logLevelResolution = resolveLogLevel([
    { source: 'option', value: options.level },
    { source: 'process-env', value: process.env[LOG_LEVEL_ENV_NAME] },
  ]);
  let dropLevelSet = new Set<LogLevelName>(resolvePureCalls(logLevelResolution.level));
  let projectRoot = process.cwd();
  let viteCacheDir = resolve(projectRoot, 'node_modules/.vite');
  let resolvedViteBase = '/';
  const htmlModuleEntries = new Set<string>();
  const moduleLocationResolver = createModuleLocationResolver(projectRoot);
  const optimizeDepsLoggingPlugin = createOptimizeDepsLoggingPlugin(
    moduleLocationResolver,
    macroIncludeFunctionName,
    () => resolvedViteBase,
  );
  const macroPlugin: OrderablePlugin = {
    config: (existingConfig, env) => {
      isBuildCommand = env.command === 'build';
      projectRoot = resolveRoot(existingConfig.root);
      moduleLocationResolver.setProjectRoot(projectRoot);
      const envDir = resolveEnvDir(existingConfig.envDir, projectRoot);
      const projectEnvLevel = loadProjectEnvLogLevel(env.mode, envDir);
      logLevelResolution = resolveLogLevel([
        { source: 'option', value: options.level },
        { source: 'process-env', value: process.env[LOG_LEVEL_ENV_NAME] },
        { source: 'project-env', value: projectEnvLevel },
      ]);
      dropLevelSet = new Set<LogLevelName>(resolvePureCalls(logLevelResolution.level));

      const config: UserConfig = {};

      if (env.command === 'serve' && macroEnabled) {
        config.optimizeDeps = {
          esbuildOptions: {
            plugins: [optimizeDepsLoggingPlugin],
          },
        };
      }

      // Force sourcemap if needed to ensure accurate line numbers
      if (
        env.command === 'build' &&
        macroEnabled &&
        macroSourcemapRetrack &&
        existingConfig.build?.sourcemap !== false &&
        !existingConfig.build?.sourcemap
      ) {
        config.build = { sourcemap: 'hidden' };
      }

      // Replace lower-level calls through AST transformation rather than esbuild.pure.
      // Pure annotations at nested call sites can produce Rollup warnings.
      // Rollup cannot interpret every annotation position.
      // "contains an annotation that Rollup cannot interpret due to the position of the comment" warnings.
      // The post-transform hook handles all call locations without esbuild assistance.

      if (Object.keys(config).length === 0) return undefined;
      return defineConfig(config);
    },
    configResolved: (resolved) => {
      projectRoot = resolved.root;
      viteCacheDir = resolved.cacheDir || resolve(projectRoot, 'node_modules/.vite');
      resolvedViteBase = resolved.base || '/';
      moduleLocationResolver.setProjectRoot(projectRoot);
      if (isBuildCommand) {
        resolved.logger.info(
          `[logline] Build log level: ${logLevelResolution.level}, source: ${describeLogLevelSource(
            logLevelResolution.source,
          )} (raw value: ${logLevelResolution.rawValue})`,
        );
      }
    },
    enforce: 'post',
    name: 'logline-pure-strip',
    transform(code, id) {
      const viteBaseResult = transformViteBaseMarker(code, id, resolvedViteBase);
      if (viteBaseResult) return viteBaseResult;

      const shouldStrip = isBuildCommand && dropLevelSet.size > 0;
      const shouldHandleMacro = macroEnabled && shouldTransformMacro(id);
      const shouldHandleStrip = shouldStrip && shouldTransformMacro(id);
      if (!shouldHandleMacro && !shouldHandleStrip) return undefined;

      // Skip prebundled dependency caches, whose prefixes were already injected.
      if (isModuleInDirectory(id, viteCacheDir)) return undefined;

      const activeDropLevelSet: ReadonlySet<LogLevelName> = shouldHandleStrip ? dropLevelSet : new Set<LogLevelName>();
      const map = macroSourcemapRetrack ? normalizeToRawSourceMap(this.getCombinedSourcemap()) : undefined;
      const location = moduleLocationResolver.resolve(id);
      const result = transformLoggingCode(
        code,
        id,
        location,
        {
          dropLevelSet: activeDropLevelSet,
          includeFunctionName: macroIncludeFunctionName,
          macroEnabled: shouldHandleMacro,
          namespace: macroNamespace,
          sourcemapRetrack: macroSourcemapRetrack,
        },
        map,
      );
      return result;
    },
  };

  if (!enableHtmlInterop && !enableIndexedDB) return macroPlugin;

  const bootstrapPlugin: OrderablePlugin = {
    enforce: 'pre',
    name: 'logline-bootstrap',
    resolveId(id) {
      if (id === AUTO_INDEXEDDB_MODULE_ID) return RESOLVED_AUTO_INDEXEDDB_MODULE_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_AUTO_INDEXEDDB_MODULE_ID) return undefined;
      const indexedDBModuleId = `${LOGLINE_MODULE_ID}/plugin/indexeddb`;
      return (
        `import { installIndexedDBLoggingPluginFromVite } from ${JSON.stringify(indexedDBModuleId)};\n` +
        `installIndexedDBLoggingPluginFromVite(${JSON.stringify(indexedDBOptions)});\n`
      );
    },
    transform(code, id) {
      const cleanId = normalizePath(id.replace(/[?#].*$/, ''));
      if (!enableIndexedDB || !htmlModuleEntries.has(cleanId)) return undefined;

      // Inject before TypeScript, JSX, and framework transforms so later stages compose sourcemaps.
      const magicString = new MagicString(code);
      magicString.prepend(`import ${JSON.stringify(AUTO_INDEXEDDB_MODULE_ID)};\n`);
      return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true, includeContent: true, source: id }),
      };
    },
    transformIndexHtml: {
      handler: async (html: string, context?: IndexHtmlTransformContext) => {
        if (enableIndexedDB) {
          for (const entry of collectHtmlModuleEntries(html, context, projectRoot)) {
            htmlModuleEntries.add(entry);
          }
        }
        if (enableHtmlInterop && htmlInteropInline) {
          if (!inlineCache) {
            inlineCache = new Map<string, Promise<string>>();
          }
          const cacheKey = `${htmlInteropTarget}-${isBuildCommand ? 'min' : 'dev'}`;
          if (!inlineCache.has(cacheKey)) {
            inlineCache.set(cacheKey, bundleHtmlInteropInline(htmlInteropTarget, isBuildCommand));
          }
          const code = await inlineCache.get(cacheKey)!;
          return injectInlineHtmlInterop(html, code, htmlInteropPosition);
        }
        if (enableHtmlInterop) return injectHtmlInteropScript(html, htmlInteropSrc, htmlInteropPosition);
        return html;
      },
      order: 'pre',
    },
  };

  return [bootstrapPlugin, macroPlugin];
};
