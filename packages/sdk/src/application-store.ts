/** Minimal pg-compatible driver. Pass a Pool, never a single shared Client. */
export interface ConnectSqlClient {
 query(sql:string,values?:any[]):Promise<{rows:any[]}>;
 release():void;
}
export interface ConnectSqlPool {connect():Promise<ConnectSqlClient>}
export interface ConnectStoreTransaction {
 get(id:string):Promise<string|null>;
 put(id:string,cipher:string,expiresAt:number):Promise<void>;
 remove(id:string):Promise<void>;
 /** Available for provisioning in the same database transaction. */
 readonly sql?:ConnectSqlClient;
 /** Commit a fail-closed refresh intent while retaining the exclusive lock. */
 checkpoint():Promise<void>;
}
export interface ConnectApplicationStore {
 /** Exclusive cross-process lock, with commit/rollback of all writes in fn. */
 transaction<T>(key:string,fn:(tx:ConnectStoreTransaction)=>Promise<T>):Promise<T>;
}
export const connectApplicationStoreMigration=`
CREATE TABLE IF NOT EXISTS connect_sdk_schema(version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS connect_sdk_records(
 namespace text NOT NULL, id text NOT NULL, cipher text NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(namespace,id));
CREATE INDEX IF NOT EXISTS connect_sdk_expiry ON connect_sdk_records(expires_at);
INSERT INTO connect_sdk_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
/** Records are encrypted by ConnectApplication; the store never sees provider tokens. */
export class PostgresConnectApplicationStore implements ConnectApplicationStore {
 constructor(private readonly pool:ConnectSqlPool,private readonly namespace:string){
  if(!namespace||namespace.length>200)throw new Error('Invalid Connect store namespace');
 }
 async migrate(){const client=await this.pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(901272)');await client.query(connectApplicationStoreMigration);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
 async prune(){const client=await this.pool.connect();try{await client.query('DELETE FROM connect_sdk_records WHERE namespace=$1 AND expires_at<=now()',[this.namespace]);}finally{client.release();}}
 async transaction<T>(key:string,fn:(tx:ConnectStoreTransaction)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect();
  try{
   await client.query("SET lock_timeout='15s'");
   await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[JSON.stringify([this.namespace,key])]);
   await client.query('BEGIN');
   const tx:ConnectStoreTransaction={sql:client,
    checkpoint:async()=>{await client.query('COMMIT');await client.query('BEGIN');},
    get:async id=>(await client.query('SELECT cipher FROM connect_sdk_records WHERE namespace=$1 AND id=$2 AND expires_at>now()',[this.namespace,id])).rows[0]?.cipher??null,
    put:async(id,cipher,expiry)=>{await client.query('INSERT INTO connect_sdk_records(namespace,id,cipher,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,id) DO UPDATE SET cipher=EXCLUDED.cipher,expires_at=EXCLUDED.expires_at',[this.namespace,id,cipher,new Date(expiry)]);},
    remove:async id=>{await client.query('DELETE FROM connect_sdk_records WHERE namespace=$1 AND id=$2',[this.namespace,id]);}
   };
   const result=await fn(tx);await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[JSON.stringify([this.namespace,key])]);await client.query('RESET lock_timeout');}finally{client.release();}}
 }
}
