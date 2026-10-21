ALTER TABLE applications ADD COLUMN IF NOT EXISTS catalog_url text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS catalog_source_version integer;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS catalog_source_hash text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS catalog_checked_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS catalog_synced_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS catalog_sync_error text;
UPDATE applications a SET catalog_url=(SELECT i.domain||i.base_path||CASE WHEN i.integration='wordpress' THEN '/index.php?eulab_catalog=1' ELSE '/.well-known/eulab-connect.json' END FROM installations i WHERE i.app_id=a.id AND i.enabled=true ORDER BY i.created_at,i.id LIMIT 1) WHERE catalog_url IS NULL;
