-- A batch is acknowledged only after COMMIT. A single primary can serve many stateless replicas.
CREATE TABLE IF NOT EXISTS log_events (
  project_id uuid NOT NULL REFERENCES projects(project_id),
  event_id text NOT NULL,
  ingest_key_id uuid REFERENCES project_keys(key_id),
  level text NOT NULL CHECK (level IN ('TRACE','DEBUG','LOG','WARN','ERROR')),
  timestamp_ms bigint NOT NULL,
  message text NOT NULL,
  fields jsonb NOT NULL,
  context jsonb NOT NULL,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  event jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ingest_seq bigserial NOT NULL,
  ingest_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY(project_id, event_id)
);
CREATE INDEX IF NOT EXISTS log_events_by_time ON log_events(project_id, timestamp_ms DESC, event_id);
CREATE INDEX IF NOT EXISTS log_events_by_trace ON log_events(project_id, (context->>'traceId'), timestamp_ms) WHERE context ? 'traceId';
CREATE INDEX IF NOT EXISTS log_events_by_session ON log_events(project_id, (context->>'sessionId'), timestamp_ms) WHERE context ? 'sessionId';
CREATE INDEX IF NOT EXISTS log_events_by_seq ON log_events(project_id, ingest_seq);
CREATE INDEX IF NOT EXISTS log_events_by_receipt ON log_events(received_at);
-- Every tag key/value pair of every event is indexed at write time; new keys need no DDL.
CREATE INDEX IF NOT EXISTS log_events_by_tags ON log_events USING GIN (tags jsonb_path_ops);

-- One row per discovered tag key; the Explorer lists live keys and prunes stale ones.
CREATE TABLE IF NOT EXISTS project_tag_keys (
  project_id uuid NOT NULL REFERENCES projects(project_id),
  tag_key text NOT NULL CHECK (length(tag_key) BETWEEN 1 AND 64 AND tag_key ~ '^[A-Za-z_][A-Za-z0-9_-]*$'),
  first_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id, tag_key)
);

-- One counter per project, never one row per event or time window.
CREATE TABLE IF NOT EXISTS log_ingest_quota (
  project_id uuid PRIMARY KEY REFERENCES projects(project_id),
  window_start timestamptz NOT NULL,
  events bigint NOT NULL,
  bytes bigint NOT NULL
);
