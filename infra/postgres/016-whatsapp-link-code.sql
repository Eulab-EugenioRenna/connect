-- Linking by phone number: WhatsApp shows an 8-character code to type on the phone, no QR to scan.
ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS link_phone text;
ALTER TABLE wa_sessions ADD COLUMN IF NOT EXISTS link_code text;
