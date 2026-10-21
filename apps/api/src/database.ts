import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg, { PoolClient } from 'pg';
import { required } from './config.js';
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 15 });
  async query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> { return (await this.pool.query<T>(sql, params)).rows; }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async onModuleDestroy() { await this.pool.end(); }
}
export async function audit(db: PoolClient, actor: string, action: string, target: string, detail: unknown = {}) {
  await db.query('INSERT INTO audit(actor,action,target,detail) VALUES($1,$2,$3,$4)', [actor,action,target,JSON.stringify(detail)]);
}
