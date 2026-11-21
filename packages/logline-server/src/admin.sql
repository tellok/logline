-- Shared authorization catalog. All foreign keys use immutable, opaque IDs.
CREATE TABLE IF NOT EXISTS users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS projects (
  project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text COLLATE "C" UNIQUE NOT NULL CHECK (length(slug) BETWEEN 1 AND 80 AND slug !~ '[^a-z0-9_-]'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200)
);
CREATE TABLE IF NOT EXISTS teams (
  team_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200)
);
CREATE TABLE IF NOT EXISTS direct_grants (
  user_id uuid NOT NULL REFERENCES users,
  project_id uuid NOT NULL REFERENCES projects,
  permissions text[] NOT NULL CHECK (permissions=ARRAY['logs:read']),
  PRIMARY KEY (user_id,project_id)
);
CREATE INDEX IF NOT EXISTS direct_grants_by_project ON direct_grants(project_id,user_id);
CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  PRIMARY KEY (team_id,user_id)
);
CREATE INDEX IF NOT EXISTS team_members_by_user ON team_members(user_id,team_id);
CREATE TABLE IF NOT EXISTS team_grants (
  team_id uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects,
  permissions text[] NOT NULL CHECK (permissions=ARRAY['logs:read']),
  PRIMARY KEY (team_id,project_id)
);
CREATE INDEX IF NOT EXISTS team_grants_by_project ON team_grants(project_id,team_id);
CREATE TABLE IF NOT EXISTS user_tokens (
  token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  secret_digest bytea UNIQUE NOT NULL CHECK (octet_length(secret_digest)=32),
  scopes text[] NOT NULL CONSTRAINT user_tokens_scopes_check CHECK (scopes=ARRAY['logs:read'] OR (scopes='{}' AND revoked_at IS NOT NULL)),
  label text NOT NULL DEFAULT '',
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS user_tokens_by_user ON user_tokens(user_id,token_id);
CREATE TABLE IF NOT EXISTS project_keys (
  key_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(project_id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  secret_digest bytea UNIQUE NOT NULL CHECK (octet_length(secret_digest)=32),
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS project_keys_by_project ON project_keys(project_id,key_id);
-- Not cached: permission changes on the primary affect the next authorization check.
CREATE OR REPLACE VIEW project_access_sources AS
  SELECT user_id,project_id,permissions,NULL::uuid AS team_id FROM direct_grants
  UNION ALL
  SELECT m.user_id,g.project_id,g.permissions,g.team_id FROM team_members m JOIN team_grants g USING(team_id);
