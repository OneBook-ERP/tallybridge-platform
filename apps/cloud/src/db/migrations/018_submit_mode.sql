-- WS-4: Per-company draft vs submitted setting
ALTER TABLE config_profiles
ADD COLUMN IF NOT EXISTS submit_mode JSONB NOT NULL DEFAULT '{"default":"draft"}';
