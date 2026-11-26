import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { Database } from './database.js';
const database = new Database();
try {
  await database.transaction(async db => {
    await db.query('SELECT pg_advisory_xact_lock(901271)');
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='001'")).rowCount) {
      await db.query(await readFile('infra/postgres/001-connect.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('001')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='002'")).rowCount) {
      await db.query(await readFile('infra/postgres/002-admin.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('002')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='003'")).rowCount) {
      await db.query(await readFile('infra/postgres/003-wordpress-users.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('003')");
    }

    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='004'")).rowCount) {
      await db.query(await readFile('infra/postgres/004-function-sources.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('004')");
    }

    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='005'")).rowCount) {
      await db.query(await readFile('infra/postgres/005-wordpress-guardian.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('005')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='006'")).rowCount) {
      await db.query(await readFile('infra/postgres/006-notifications.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('006')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='007'")).rowCount) {
      await db.query(await readFile('infra/postgres/007-whatsapp-bots.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('007')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='008'")).rowCount) {
      await db.query(await readFile('infra/postgres/008-whatsapp-realtime.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('008')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='009'")).rowCount) {
      await db.query(await readFile('infra/postgres/009-whatsapp-unlocked.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('009')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='010'")).rowCount) {
      await db.query(await readFile('infra/postgres/010-team-delegation.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('010')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='011'")).rowCount) {
      await db.query(await readFile('infra/postgres/011-app-onboarding.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('011')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='012'")).rowCount) {
      await db.query(await readFile('infra/postgres/012-onboarding-recovery.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('012')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='013'")).rowCount) {
      await db.query(await readFile('infra/postgres/013-onboarding-presenters.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('013')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='014'")).rowCount) {
      await db.query(await readFile('infra/postgres/014-delegated-accounts.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('014')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='015'")).rowCount) {
      await db.query(await readFile('infra/postgres/015-automation-delegations.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('015')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='016'")).rowCount) {
      await db.query(await readFile('infra/postgres/016-whatsapp-link-code.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('016')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='017'")).rowCount) {
      await db.query(await readFile('infra/postgres/017-outbox-verified-retry.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('017')");
    }
    if (!(await db.query("SELECT 1 FROM schema_migrations WHERE version='018'")).rowCount) {
      await db.query(await readFile('infra/postgres/018-whatsapp-history-per-number.sql','utf8'));
      await db.query("INSERT INTO schema_migrations(version) VALUES('018')");
    }
  });
  console.log('Migrazioni 001–018 verificate');
} finally { await database.onModuleDestroy(); }
