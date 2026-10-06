ALTER TABLE demo_host ADD COLUMN owner_user_id bigint NOT NULL DEFAULT 0;

CREATE TABLE hosted_connection_tickets (
  digest text PRIMARY KEY,
  owner text NOT NULL,
  epoch uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
