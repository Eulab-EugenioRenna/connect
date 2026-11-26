-- History is kept per licence and number: the first link of a number reads everything,
-- later links of the same number only add what is new.
ALTER TABLE wa_archives ADD COLUMN IF NOT EXISTS history_synced_at timestamptz;
ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS sync_mode text;
-- Archives already fully read once are not read again from the start.
UPDATE wa_archives a SET history_synced_at=now()
 WHERE history_synced_at IS NULL
   AND EXISTS (SELECT 1 FROM wa_sessions s WHERE s.archive_id=a.id AND s.sync_status='available_history_synced');
