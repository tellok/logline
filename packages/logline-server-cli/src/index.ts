#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { stdin, stdout, stderr } from 'node:process';
import { parseArgs } from 'node:util';
import { explorerPrefix, parseResponse, queryExplorer, type Request } from './api.js';
import { formatLogs, isRecord, visible } from './output.js';

const help = `Usage: logline-server-cli <command> [options]

Commands
  project list                   List projects you can read
  log list                       Search recent logs
  log view <project> <event>     Show a full log event
  log context <project> <event>  Show nearby or correlated logs
  api <path>                     Query an Explorer endpoint

Connection and output
  --url <url>                    Deployment URL (or LOGLINE_URL)
  --token <token>                Personal access token (or LOGLINE_AUTH_TOKEN)
  --raw, --json                  Write the original JSON response to stdout
  -h, --help                     Show this help

Log search options
  -p, --project <uuid>           Restrict to a project ID (repeatable)
  -e, --environment <name>       Restrict to an environment (repeatable)
  -t, --period <range>            Relative (e.g. 2h) or ISO start..end (default: 1h)
  -l, --level <level>             TRACE, DEBUG, LOG, WARN, or ERROR
  -q, --query <text>              Case-insensitive message substring
  --trace <id>                   Match an exact trace ID
  -s, --sort <order>              newest or oldest (default: newest)
  --cursor <cursor>              Continue a previous search

Other options
  -n, --limit <count>             Page size for log list, log context, or project list
  --offset <count>               Project list offset
  --mode <mode>                  Context mode: nearby, trace, or session (default: nearby)
  -d, --data <json|@file|@->      Explorer POST body for api (use @- for stdin)

Examples
  logline-server-cli log list --level error --period 2h --query 'timeout'
  logline-server-cli log list --limit 20 --raw | jq '.items[]'
  logline-server-cli api groups --data '{"query":{"range":{"last":"2h"}},"groupBy":["level"]}'
`;

function parse(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        url: { type: 'string' },
        token: { type: 'string' },
        raw: { type: 'boolean' },
        json: { type: 'boolean' },
        project: { type: 'string', short: 'p', multiple: true },
        environment: { type: 'string', short: 'e', multiple: true },
        period: { type: 'string', short: 't' },
        level: { type: 'string', short: 'l' },
        query: { type: 'string', short: 'q' },
        trace: { type: 'string' },
        sort: { type: 'string', short: 's' },
        cursor: { type: 'string' },
        limit: { type: 'string', short: 'n' },
        offset: { type: 'string' },
        mode: { type: 'string' },
        data: { type: 'string', short: 'd' },
      },
    });
  } catch {
    throw new Error('Invalid options. Run logline-server-cli --help for usage.');
  }
}

type Options = ReturnType<typeof parse>['values'];

function checkOptions(options: Options, allowed: (keyof Options)[]): void {
  const common = ['help', 'url', 'token', 'raw', 'json'];
  const invalid = Object.keys(options).find((key) => ![...common, ...allowed].includes(key));
  if (invalid) throw new Error(`--${invalid} is unavailable for this command.`);
}

function integer(name: string, input: string | undefined, min: number, max: number): number | undefined {
  if (input === undefined) return undefined;
  const value = Number(input);
  if (!/^\d+$/.test(input) || value < min || value > max)
    throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function choice(name: string, input: string | undefined, choices: string[]): string | undefined {
  if (input !== undefined && !choices.includes(input))
    throw new Error(`--${name} must be one of ${choices.join(', ')}.`);
  return input;
}

function logList(options: Options): Request {
  checkOptions(options, ['project', 'environment', 'period', 'level', 'query', 'trace', 'sort', 'cursor', 'limit']);
  const where = [];
  const level = choice('level', options.level?.toUpperCase(), ['TRACE', 'DEBUG', 'LOG', 'WARN', 'ERROR']);
  if (level) where.push({ field: 'level', op: 'eq', value: level });
  if (options.query !== undefined) where.push({ field: 'message', op: 'icontains', value: options.query });
  if (options.trace !== undefined) where.push({ field: 'traceId', op: 'eq', value: options.trace });

  const period = options.period ?? '1h';
  const [start, end, ...extra] = period.split('..');
  if (extra.length || (end === undefined ? !/^\d+[mhd]$/.test(start) : !start || !end))
    throw new Error('--period expects a duration such as 2h or ISO start..end.');
  const order = choice('sort', options.sort, ['newest', 'oldest']);
  return {
    path: 'rows',
    method: 'POST',
    body: {
      query: {
        projectIds: options.project,
        environments: options.environment,
        range: end === undefined ? { last: start } : { start, end },
        where: where.length > 1 ? { and: where } : where[0],
      },
      limit: integer('limit', options.limit, 1, 100),
      sort: order === 'oldest' ? 'asc' : 'desc',
      cursor: options.cursor,
    },
  };
}

const postRoutes = new Set([
  'rows',
  'detail',
  'context',
  'selectors',
  'fields',
  'groups',
  'series',
  'refresh',
  'export',
]);

async function readBody(data: string | undefined): Promise<Record<string, unknown>> {
  if (data === undefined) return {};
  let text = data;
  try {
    if (data === '@-') {
      const chunks: string[] = [];
      stdin.setEncoding('utf8');
      for await (const chunk of stdin) chunks.push(chunk);
      text = chunks.join('');
    } else if (data.startsWith('@')) {
      text = await readFile(data.slice(1), 'utf8');
    }
  } catch {
    throw new Error('Could not read the API request body.');
  }
  const body = parseResponse(text);
  if (!isRecord(body)) throw new Error('--data must contain a JSON object.');
  return body;
}

async function apiRequest(input: string, options: Options): Promise<Request> {
  checkOptions(options, ['data']);
  const path = input.startsWith(explorerPrefix) ? input.slice(explorerPrefix.length) : input.replace(/^\//, '');
  const [route] = path.split('?', 1);
  if (path.includes('#')) throw new Error('Explorer paths cannot include a fragment.');
  if (route === 'projects' || /^views(?:\/[a-f\d-]{36})?$/i.test(route)) {
    if (options.data !== undefined) throw new Error('--data can only be used with a POST query.');
    return { path, method: 'GET' };
  }
  if (postRoutes.has(route) && path === route) return { path, method: 'POST', body: await readBody(options.data) };
  throw new Error('Expected a read-only Explorer path such as projects, rows, or groups.');
}

/** Map CLI arguments to the Explorer request and choose an output mode. Writes results to stdout. */
async function main(args: string[]): Promise<void> {
  const { positionals, values } = parse(args);
  if (values.help || args.length === 0) {
    stdout.write(help);
    return;
  }
  const [command, action, projectId, eventId, ...extra] = positionals;
  const token = (values.token ?? process.env.LOGLINE_AUTH_TOKEN)?.trim();
  const url = (values.url ?? process.env.LOGLINE_URL)?.trim();
  let request: Request;
  if (command === 'api' && action && positionals.length === 2) {
    request = await apiRequest(action, values);
  } else if (command === 'project' && action === 'list' && positionals.length === 2) {
    checkOptions(values, ['limit', 'offset']);
    const pagination = new URLSearchParams();
    const limit = integer('limit', values.limit, 1, 100);
    const offset = integer('offset', values.offset, 0, 10_000);
    if (limit !== undefined) pagination.set('limit', String(limit));
    if (offset !== undefined) pagination.set('offset', String(offset));
    request = { method: 'GET', path: pagination.size ? `projects?${pagination}` : 'projects' };
  } else if (command === 'log' && action === 'list' && positionals.length === 2) {
    request = logList(values);
  } else if (
    command === 'log' &&
    (action === 'view' || action === 'context') &&
    projectId &&
    eventId &&
    !extra.length
  ) {
    checkOptions(values, action === 'context' ? ['mode', 'limit'] : []);
    request = {
      path: action === 'view' ? 'detail' : 'context',
      method: 'POST',
      body: {
        projectId,
        eventId,
        mode: choice('mode', values.mode, ['nearby', 'trace', 'session']),
        limit: integer('limit', values.limit, 1, 100),
      },
    };
  } else {
    throw new Error('Invalid command or arguments. Run logline-server-cli --help for usage.');
  }

  if (!url) throw new Error('Set LOGLINE_URL or pass --url.');
  if (!token || !/^[!-~]+$/.test(token)) throw new Error('Set LOGLINE_AUTH_TOKEN or pass a valid --token.');
  const raw = await queryExplorer(url, token, request);
  if (values.raw || values.json) {
    stdout.write(raw);
    return;
  }
  const payload = parseResponse(raw.toString('utf8'));
  if (payload === undefined) throw new Error('The server did not return JSON. Check the deployment URL.');
  const output =
    command === 'log'
      ? formatLogs(payload, action === 'view', stdout.isTTY && stdout.hasColors() && process.env.NO_COLOR === undefined)
      : JSON.stringify(payload, undefined, 2).split('\n').map(visible).join('\n') + '\n';
  stdout.write(output);
}

stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') return;
  stderr.write('logline-server-cli: Could not write output.\n');
  process.exitCode = 1;
});

main(process.argv.slice(2)).catch((error: unknown) => {
  stderr.write(`logline-server-cli: ${error instanceof Error ? error.message : 'Unexpected failure.'}\n`);
  process.exitCode = 1;
});
