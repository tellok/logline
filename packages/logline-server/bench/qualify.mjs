// Offline qualification of the documented 2-replica mixed steady profile (not a statistical SLA).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const file = process.argv[2];
assert(file, 'Usage: node qualify.mjs steady.json');
const r = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(r.protocol, 'project-dsn-v2', 'Not current DSN-key evidence (legacy v1 used a PAT for uploads).');
const p = r.profile;
const validSamples = (name) => r.latency[name]?.n > 0;
const checks = {
  profile:
    p.replicas === 2 &&
    p.projects === 24 &&
    p.seconds === 120 &&
    p.eventsPerSecond === 1000 &&
    p.batch === 50 &&
    p.writers === 6 &&
    p.readers === 3 &&
    p.padding === 192 &&
    !p.hot &&
    p.mcp,
  acceptedEventsPerSecond: r.eventsPerSec >= 950,
  acceptedKiBPerSecond: r.bytesPerSec >= 320 * 1024,
  uploadP95: validSamples('uploadAckMs') && r.latency.uploadAckMs.p95 < 150,
  uploadP99: validSamples('uploadAckMs') && r.latency.uploadAckMs.p99 < 500,
  queryP95: validSamples('queryAttemptMs') && r.latency.queryAttemptMs.p95 < 150,
  queryP99: validSamples('queryAttemptMs') && r.latency.queryAttemptMs.p99 < 500,
  visibilityP99: validSamples('ackToVisibleMs') && r.latency.ackToVisibleMs.p99 < 500,
  correctness:
    r.ackErrors === 0 &&
    r.deferred === 0 &&
    r.visibilityFailures === 0 &&
    r.ingestKeyMismatches === 0 &&
    r.replayOk &&
    r.revokedStatus.length === 2 &&
    r.revokedStatus.every((s) => s === 401) &&
    r.crossProjectStatus === 403 &&
    r.revokedKeyStatus?.length === 2 &&
    r.revokedKeyStatus.every((s) => s === 401) &&
    Object.keys(r.failures).length === 0 &&
    r.counts.length === p.projects &&
    r.counts.every((n, i) => typeof n === 'number' && n > 0 && n === r.acks[i]),
};
for (const [key, pass] of Object.entries(checks)) console.log(`${pass ? 'PASS' : 'FAIL'} ${key}`);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
