import {Injectable,NotFoundException,ConflictException,BadRequestException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {Database,audit} from './database.js';
import {parse,catalogSchema} from './validation.js';
import {functionMatrixSchema} from './function-matrix.js';
import {hash} from './security.js';
import {z} from 'zod';
@Injectable()
export class CatalogService {
 constructor(private readonly db:Database){}
 private async apply(tx:PoolClient,id:string,b:z.infer<typeof catalogSchema>,actor:string,flatten=false,sourceDocument?:unknown){
  for(const f of b.features)await tx.query('INSERT INTO features(app_id,key,name) VALUES($1,$2,$3) ON CONFLICT(app_id,key) DO UPDATE SET name=$3,active=true',[id,f.key,f.name]);
  for(const p of b.permissions){
   const old=(await tx.query('SELECT feature_key FROM permissions WHERE app_id=$1 AND key=$2',[id,p.key])).rows[0];
   if(old&&old.feature_key!==p.feature){
    if(!flatten)throw new BadRequestException('Un permesso esistente non può cambiare funzione');
    // Preserve previous commercial grants for this exact, previously declared function.
    await tx.query('INSERT INTO entitlements(customer_id,app_id,feature_key,purchased,enabled) SELECT customer_id,app_id,$3,purchased,enabled FROM entitlements WHERE app_id=$1 AND feature_key=$2 ON CONFLICT(customer_id,app_id,feature_key) DO NOTHING',[id,old.feature_key,p.feature]);
   }
   await tx.query('INSERT INTO permissions(app_id,key,feature_key,name) VALUES($1,$2,$3,$4) ON CONFLICT(app_id,key) DO UPDATE SET feature_key=$3,name=$4,active=true',[id,p.key,p.feature,p.name]);
  }
  await tx.query('UPDATE features SET active=(key=ANY($2::text[])) WHERE app_id=$1',[id,b.features.map(f=>f.key)]);
  await tx.query('UPDATE permissions SET active=(key=ANY($2::text[])) WHERE app_id=$1',[id,b.permissions.map(p=>p.key)]);
  await tx.query('UPDATE entitlements SET enabled=false WHERE app_id=$1 AND NOT(feature_key=ANY($2::text[]))',[id,b.features.map(f=>f.key)]);
  await tx.query('DELETE FROM role_permissions WHERE app_id=$1 AND NOT(permission_key=ANY($2::text[]))',[id,b.permissions.map(p=>p.key)]);
  await tx.query('INSERT INTO catalogs VALUES($1,$2,$3)',[id,b.version,JSON.stringify(sourceDocument||b)]);
  await tx.query('UPDATE applications SET catalog_version=$2 WHERE id=$1',[id,b.version]);
  await audit(tx,actor,flatten?'functions.import':'catalog.publish',id,b);
 }
 // Internal compatibility for historical catalogs; no administrative HTTP publication.
 async publish(id:string,body:unknown,actor:string){
  const b=parse(catalogSchema,body);
  return this.db.transaction(async tx=>{const app=(await tx.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!app)throw new NotFoundException();if(b.version<=app.catalog_version)throw new ConflictException('Versione catalogo non crescente');await this.apply(tx,id,b,actor);return b;});
 }
 async importMatrix(id:string,url:string,body:unknown,actor:string){
  const matrix=parse(functionMatrixSchema,body);if(matrix.appId!==id)throw new BadRequestException('La matrice appartiene a un’altra app');
  matrix.functions.sort((a,b)=>a.key.localeCompare(b.key));const digest=hash(JSON.stringify(matrix));
  return this.db.transaction(async tx=>{
   const app=(await tx.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!app)throw new NotFoundException();if(app.catalog_url!==url)throw new ConflictException('URL matrice cambiato durante la lettura');
   if(app.catalog_source_version!==null&&matrix.version<app.catalog_source_version)throw new ConflictException('Versione matrice precedente a quella acquisita');
   if(matrix.version===app.catalog_source_version&&digest!==app.catalog_source_hash)throw new ConflictException('Matrice modificata senza incrementare la versione');
   const changed=digest!==app.catalog_source_hash;
   if(changed)await this.apply(tx,id,{version:app.catalog_version+1,features:matrix.functions.map(f=>({key:f.key,name:f.name})),permissions:matrix.functions.map(f=>({key:f.key,name:f.name,feature:f.key}))},actor,true,matrix);
   await tx.query('UPDATE applications SET catalog_source_version=$2,catalog_source_hash=$3,catalog_synced_at=now(),catalog_checked_at=now(),catalog_sync_error=null WHERE id=$1',[id,matrix.version,digest]);
   return {changed,version:matrix.version,functions:matrix.functions};
  });
 }
}
