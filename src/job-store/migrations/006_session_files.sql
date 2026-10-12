CREATE TABLE session_file_namespaces (
  id uuid PRIMARY KEY,
  principal text NOT NULL,
  epoch uuid NOT NULL,
  worker text NOT NULL,
  lease_until timestamptz NOT NULL,
  max_bytes integer NOT NULL CHECK (max_bytes > 0),
  max_entries integer NOT NULL CHECK (max_entries > 0)
);

CREATE TABLE session_files (
  namespace_id uuid NOT NULL REFERENCES session_file_namespaces(id) ON DELETE CASCADE,
  path text NOT NULL,
  directory boolean NOT NULL,
  content bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, path),
  CHECK (left(path, 1) = '/'),
  CHECK ((directory AND content IS NULL) OR (NOT directory AND content IS NOT NULL))
);
