-- Apply after the identity and event migrations. All replicas share cursor signing material.
CREATE TABLE IF NOT EXISTS explorer_keys (
  singleton boolean PRIMARY KEY CHECK (singleton),
  secret uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO explorer_keys(singleton) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS explorer_views (
  view_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private','link')),
  version integer NOT NULL DEFAULT 1,
  project_ids uuid[] NOT NULL,
  definition jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS explorer_views_owner_idx ON explorer_views(owner_id, view_id);
CREATE INDEX IF NOT EXISTS log_events_explorer_time_idx ON log_events(project_id, timestamp_ms, event_id);
CREATE INDEX IF NOT EXISTS log_events_explorer_poll_idx ON log_events(project_id, ingest_xid, ingest_seq);
