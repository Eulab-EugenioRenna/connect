import {Injectable,OnApplicationBootstrap,OnModuleDestroy,BadRequestException,ConflictException,NotFoundException} from '@nestjs/common';
import {Database,audit} from './database.js';
import {CatalogService} from './catalog.service.js';
import {CatalogReader} from './catalog-reader.js';
import {defaultCatalogUrl} from './function-matrix.js';
@Injectable()
export class CatalogSourceService implements OnApplicationBootstrap,OnModuleDestroy {
 private timer?:ReturnType<typeof setInterval>;private scanning=false;private readonly pending=new Map<string,Promise<unknown>>();
 constructor(private readonly db:Database,private readonly catalogs:CatalogService,private readonly reader:CatalogReader){}
 async validateUrl(appId:string,value:string,installationId?:string){
  let url:URL;try{url=new URL(value);}catch{throw new BadRequestException('URL matrice non valido');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash)throw new BadRequestException('URL matrice non valido');
  const sites=await this.db.query('SELECT domain,base_path FROM installations WHERE app_id=$1 AND enabled=true AND ($2::uuid IS NULL OR id=$2)',[appId,installationId||null]);
  if(!sites.some(s=>url.origin===s.domain&&(url.pathname===s.base_path||url.pathname.startsWith(s.base_path+'/'))))throw new BadRequestException('URL matrice esterno alle installazioni dell’app');
  return url.href;
 }
 async configure(appId:string,value:string,actor:string,installationId?:string){
  const url=await this.validateUrl(appId,value,installationId);
  return this.db.transaction(async tx=>{
   const app=(await tx.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE',[appId])).rows[0];if(!app)throw new NotFoundException();
   if(installationId&&app.catalog_url&&app.catalog_url!==url){const site=(await tx.query('SELECT * FROM installations WHERE id=$1',[installationId])).rows[0];if(app.catalog_source_version!==null||app.catalog_url!==defaultCatalogUrl(site))throw new ConflictException('La fonte dell’app è già configurata su un altro URL');}
   if(app.catalog_url!==url){await tx.query('UPDATE applications SET catalog_url=$2,catalog_source_version=null,catalog_source_hash=null,catalog_checked_at=null,catalog_sync_error=null WHERE id=$1',[appId,url]);await audit(tx,actor,'functions.source.update',appId,{url});}
   return {url};
  });
 }
 async sync(id:string,actor='catalog-sync'):Promise<any>{
  if(this.pending.has(id))return this.pending.get(id);
  const task=(async()=>{
   const [app]=await this.db.query('SELECT catalog_url FROM applications WHERE id=$1',[id]);if(!app?.catalog_url)throw new BadRequestException('URL matrice non configurato');const url=app.catalog_url;
   try{await this.validateUrl(id,url);const result=await this.catalogs.importMatrix(id,url,await this.reader.read(url),actor);return {ok:true,url,...result};}
   catch(error){const message=error instanceof Error?error.message:'Lettura matrice non riuscita';await this.db.query('UPDATE applications SET catalog_checked_at=now(),catalog_sync_error=$3 WHERE id=$1 AND catalog_url=$2',[id,url,message.slice(0,500)]);return {ok:false,url,error:message};}
  })().finally(()=>this.pending.delete(id));this.pending.set(id,task);return task;
 }
 async refreshDue(){if(this.scanning)return;this.scanning=true;try{const apps=await this.db.query("SELECT id FROM applications WHERE catalog_url IS NOT NULL AND (catalog_checked_at IS NULL OR catalog_checked_at<now()-interval '60 seconds') AND EXISTS(SELECT 1 FROM installations i WHERE i.app_id=applications.id AND i.enabled=true) ORDER BY catalog_checked_at NULLS FIRST LIMIT 20");await Promise.allSettled(apps.map(a=>this.sync(a.id)));}finally{this.scanning=false;}}
 onApplicationBootstrap(){void this.refreshDue().catch(()=>undefined);this.timer=setInterval(()=>void this.refreshDue().catch(()=>undefined),10000);this.timer.unref();}
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
}
