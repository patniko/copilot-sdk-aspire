ALTER TABLE demo_host ADD COLUMN execution text NOT NULL DEFAULT 'managed'
  CHECK (execution IN ('managed', 'github-native'));
