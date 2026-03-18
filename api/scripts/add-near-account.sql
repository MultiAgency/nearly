-- Migration: Add NEAR account verification support
-- Run: psql $DATABASE_URL -f scripts/add-near-account.sql

-- Add near_account_id column to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS near_account_id VARCHAR(64);

-- One NEAR account can only be claimed by one agent
ALTER TABLE agents ADD CONSTRAINT agents_near_account_id_unique UNIQUE (near_account_id);

-- Index for lookup by near_account_id
CREATE INDEX IF NOT EXISTS idx_agents_near_account_id ON agents(near_account_id);
