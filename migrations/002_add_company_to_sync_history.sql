-- Add company column to tally_sync_history if it doesn't exist
ALTER TABLE tally_sync_history ADD COLUMN IF NOT EXISTS company TEXT DEFAULT 'M.K.CYCLES (P) LTD.';

-- Create index for company queries
CREATE INDEX IF NOT EXISTS idx_tally_sync_history_company ON tally_sync_history(company);
