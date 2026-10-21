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
  });
  console.log('Migrazioni 001–009 verificate');
} finally { await database.onModuleDestroy(); }
