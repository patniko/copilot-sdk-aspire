-- Where each session's loop runs now. The generation increases on every placement change; connection tickets bind
-- to it, and the connection broker closes routes to an older generation. Extend the named kind constraint when a
-- new placement kind can accept brokered connections.
ALTER TABLE shared_sessions
  ADD COLUMN placement text NOT NULL DEFAULT 'shared',
  ADD COLUMN placement_generation integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT shared_sessions_placement_kind CHECK (placement IN ('shared')),
  ADD CONSTRAINT shared_sessions_placement_generation CHECK (placement_generation > 0);

ALTER TABLE shared_connection_tickets ADD COLUMN placement_generation integer NOT NULL DEFAULT 1;
