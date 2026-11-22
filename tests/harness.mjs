import pgDriver from 'pg';
import 'reflect-metadata';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {PGlite} from '@electric-sql/pglite';
import {Test} from '@nestjs/testing';
export async function harness(settings={}){
 const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test-key';
 let revoked=false;let issuer;const grants=new Map();
 async function token(subject='operator',roles=['eulab-admin']){return new SignJWT({realm_access:{roles}}).setSubject(subject).setIssuer(issuer).setAudience('connect-api').setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuedAt().setExpirationTime('5m').sign(privateKey);}
 issuer=settings.realOidc?.issuer||'https://oidc.test/realms/eulab';
 const originalFetch=globalThis.fetch;
 async function oidcFetch(input,options={}){
  const url=new URL(String(input)),params=new URLSearchParams(options.body||'');
  if(url.pathname.endsWith('/certs')){const extra=settings.realOidc?(await (await originalFetch(input,options)).json()).keys:[];return Response.json({keys:[jwk,...extra]});}
  if(url.pathname.endsWith('/auth')){if(settings.realOidc)return originalFetch(input,options);const code=crypto.randomUUID();grants.set(code,{challenge:url.searchParams.get('code_challenge')});const redirect=new URL(url.searchParams.get('redirect_uri'));redirect.searchParams.set('code',code);redirect.searchParams.set('state',url.searchParams.get('state'));return new Response(null,{status:302,headers:{Location:redirect.href}});}
  if(url.pathname.endsWith('/token/introspect')){
   let claims={};try{claims=JSON.parse(Buffer.from(params.get('token').split('.')[1],'base64url').toString());}catch{}
   if(settings.realOidc&&JSON.parse(Buffer.from(params.get('token').split('.')[0],'base64url').toString()).kid!=='test-key')return originalFetch(input,options);
   return Response.json({active:!revoked&&!!claims.sub,sub:claims.sub,realm_access:claims.realm_access});
  }
  if(url.pathname.endsWith('/token')){if(settings.realOidc)return originalFetch(input,options);const grant=grants.get(params.get('code'));grants.delete(params.get('code'));if(!grant||createHash('sha256').update(params.get('code_verifier')||'').digest('base64url')!==grant.challenge)return Response.json({},{status:400});return Response.json({access_token:await token()});}
  return settings.realOidc?originalFetch(input,options):Response.json({},{status:404});
 }
 globalThis.fetch=(input,options)=>String(input).startsWith(issuer)?oidcFetch(input,options):originalFetch(input,options);
 Object.assign(process.env,{DATABASE_URL:'postgres://unused',REDIS_URL:'redis://127.0.0.1:6379',DATA_ENCRYPTION_KEY:'a'.repeat(64),MIGRATION_ENCRYPTION_KEY:'b'.repeat(64),ONBOARDING_PASSWORD_TTL_SECONDS:'86400',OIDC_ISSUER:issuer,OIDC_INTERNAL_ISSUER:issuer,OIDC_JWKS_URL:issuer+'/protocol/openid-connect/certs',OIDC_CLIENT_SECRET:settings.realOidc?.clientSecret||'test-only'});
 let pg;
 if(settings.databaseUrl){
  const schema='qa_'+crypto.randomUUID().replaceAll('-','');
  const admin=new pgDriver.Pool({connectionString:settings.databaseUrl});await admin.query('CREATE SCHEMA '+schema);
  const pool=new pgDriver.Pool({connectionString:settings.databaseUrl,options:'-c search_path='+schema});
  pg={exec:sql=>pool.query(sql),query:(sql,params)=>pool.query(sql,params),transaction:async fn=>{const tx=await pool.connect();try{await tx.query('BEGIN');const value=await fn(tx);await tx.query('COMMIT');return value;}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}},close:async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}};
 }else pg=new PGlite();await pg.exec(await readFile('infra/postgres/001-connect.sql','utf8'));await pg.exec(await readFile('infra/postgres/002-admin.sql','utf8'));await pg.exec(await readFile('infra/postgres/003-wordpress-users.sql','utf8'));await pg.exec(await readFile('infra/postgres/004-function-sources.sql','utf8'));await pg.exec(await readFile('infra/postgres/005-wordpress-guardian.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/006-notifications.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/007-whatsapp-bots.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/008-whatsapp-realtime.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/009-whatsapp-unlocked.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/010-team-delegation.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/011-app-onboarding.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/012-onboarding-recovery.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/013-onboarding-presenters.sql','utf8'));
 await pg.exec(await readFile('infra/postgres/014-delegated-accounts.sql','utf8'));
 if(settings.beforeAutomationMigration)await settings.beforeAutomationMigration(pg);
 await pg.exec(await readFile('infra/postgres/015-automation-delegations.sql','utf8'));
 const store={query:async(sql,params=[])=> (await pg.query(sql,params)).rows,transaction:async fn=>pg.transaction(async tx=>fn({query:async(sql,params=[])=>{const r=await tx.query(sql,params);return {...r,rowCount:r.rowCount??r.affectedRows??r.rows.length};}})),onModuleDestroy:async()=>{}};
 const {AppModule,configureApp}=await import('../dist/server/apps/api/src/app.js');const {Database}=await import('../dist/server/apps/api/src/database.js');
 let readCatalog=async()=>{throw new Error('Fonte di test non disponibile');};
 const {CatalogReader}=await import('../dist/server/apps/api/src/catalog-reader.js');
 const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(Database).useValue(store).overrideProvider(CatalogReader).useValue({read:(url)=>readCatalog(url)}).compile();
 const app=await configureApp(module.createNestApplication({bodyParser:false,logger:false}));await app.init();const apiUrl='https://connect.test';
 // Use one HTTP transport throughout: injecting before listen mutates Express request prototypes.
 await app.listen(0,'127.0.0.1');
 const networkBase='http://127.0.0.1:'+app.getHttpServer().address().port;
 const adminToken=await token();

 async function injectRequest(path,method='GET',body,headers={}){
   const r=await originalFetch(networkBase+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
   const text=await r.text();return {status:r.status,headers:Object.fromEntries(r.headers),text,body:text?JSON.parse(text):null};
 }
 async function request(path,method='GET',body,headers={}){return injectRequest(path,method,body,{Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json',...headers});}
 const {IdentitiesService}=await import('../dist/server/apps/api/src/identities.service.js');
 const {MailService}=await import('../dist/server/apps/api/src/mail.service.js');
 const {WhatsAppService}=await import('../dist/server/apps/api/src/whatsapp.service.js');
 return {listen:async()=>networkBase,setWhatsAppQueue:fn=>{app.get(WhatsAppService).queue=fn;},setMailSend:fn=>{app.get(MailService).send=fn;},setIdentityRequest:fn=>{app.get(IdentitiesService).request=fn;},setCatalogReader:fn=>{readCatalog=fn;},apiUrl,issuer,pg,store,token,request,injectRequest,oidcFetch,setRevoked:v=>{revoked=v;},close:async()=>{await app.close();await pg.close();globalThis.fetch=originalFetch;}};
}
