import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {scryptSync,timingSafeEqual,randomBytes} from 'node:crypto';
import pg from 'pg';
import {ConnectApplication,ConnectApplicationError,PostgresConnectApplicationStore} from '@eulab/connect/application';
import {defineFunctions,functionsResponse} from '@eulab/connect/server';
const required=key=>{if(!process.env[key])throw Error('Missing '+key);return process.env[key];};
const pool=new pg.Pool({connectionString:required('DATABASE_URL'),max:10});
const store=new PostgresConnectApplicationStore(pool,required('CONNECT_SOURCE_ID'));
const origin=required('CONNECT_ORIGIN');
const catalog=defineFunctions({appId:required('CONNECT_APP_ID'),version:1,functions:[{key:'projects.read',name:'Read projects'}]});
const accounts={
 async verifyLegacy({email,password}){
  // An ambiguous local account requires local selection; it never chooses a company by guessing.
  const {rows}=await pool.query('SELECT * FROM workshop_accounts WHERE lower(email)=lower($1)',[email]);
  const row=rows.length===1?rows[0]:null;
  if(!row?.password_hash||!timingSafeEqual(scryptSync(password,row.password_salt,32),Buffer.from(row.password_hash,'hex')))return null;
  return {localTenant:{id:row.tenant_id,name:'Workshop',slug:'workshop'},localUser:{id:row.id,email:row.email,firstName:row.first_name,lastName:row.last_name,role:'owner',permissions:['projects.read']}};
 },
 async provision(context,{transaction}){
  const {tenant,user,binding}=context;
  // Same connection and transaction as handoff consumption. No email join, no legacy hash update.
  const {rows}=await transaction.sql.query(`INSERT INTO workshop_accounts(tenant_id,id,email,first_name,last_name,connect_subject,connect_installation)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,id) DO UPDATE SET connect_subject=EXCLUDED.connect_subject,connect_installation=EXCLUDED.connect_installation
   WHERE (workshop_accounts.connect_subject IS NULL OR workshop_accounts.connect_subject=EXCLUDED.connect_subject)
   AND (workshop_accounts.connect_installation IS NULL OR workshop_accounts.connect_installation=EXCLUDED.connect_installation) RETURNING id`,
   [tenant.id,user.id,user.email,user.firstName,user.lastName,user.subject,binding.installationId]);
  if(rows.length!==1)throw new ConnectApplicationError('provision_conflict');
  return {localTenantId:tenant.id,localUserId:user.id};
 },
 async restrict(profile,key,resource){return key==='projects.read'&&resource?.tenantId===profile.localTenantId;}
};
// The only SDK instance in this application. Existing team/WhatsApp/catalog methods remain available through services().
const connect=new ConnectApplication({apiUrl:required('CONNECT_API_URL'),sourceId:required('CONNECT_SOURCE_ID'),sourceSecret:process.env.CONNECT_SOURCE_SECRET,appId:catalog.appId,
 ...(process.env.CONNECT_PRESENTER_ID?{presenter:{id:process.env.CONNECT_PRESENTER_ID,secret:required('CONNECT_PRESENTER_SECRET'),deployment:{name:required('CONNECT_DEPLOYMENT_NAME'),environment:'development',origins:[origin],catalogUrl:origin+'/.well-known/eulab-connect.json',oidcCallbacks:[origin+'/callback']}}}:{}),
 issuer:process.env.CONNECT_ISSUER||undefined,clientId:process.env.CONNECT_CLIENT_ID||undefined,clientSecret:process.env.CONNECT_CLIENT_SECRET||undefined,
 appOrigin:origin,redirectUri:process.env.CONNECT_ISSUER?origin+'/callback':undefined,allowLoopbackHttp:true,encryptionKey:required('CONNECT_ENCRYPTION_KEY'),store,accounts,catalog});
if(process.argv.includes('--check')){console.log(JSON.stringify(await connect.diagnose(process.env.DEMO_LEGACY_EMAIL),null,2));await pool.end();}
else if(process.argv.includes('--migrate')){await store.migrate();await pool.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));await pool.end();}
else if(process.argv.includes('--seed')){
 const password=required('DEMO_LEGACY_PASSWORD'),salt=randomBytes(16).toString('hex');
 await pool.query("INSERT INTO workshop_accounts(tenant_id,id,email,first_name,last_name,password_salt,password_hash) VALUES('workspace-1','local-1',$1,'Demo','User',$2,$3) ON CONFLICT DO NOTHING",[required('DEMO_LEGACY_EMAIL'),salt,scryptSync(password,salt,32).toString('hex')]);
 await pool.query("INSERT INTO workshop_projects(id,tenant_id,name) VALUES('demo-project','workspace-1','First project') ON CONFLICT DO NOTHING");await pool.end();
}else{
 const cookieString=c=>`${c.name}=${encodeURIComponent(c.value)}; Path=${c.path}; Max-Age=${c.maxAge}; HttpOnly; SameSite=Lax${c.secure?'; Secure':''}`;
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send=(data,status=200,cookies=[])=>{res.writeHead(status,{'content-type':'application/json','set-cookie':cookies.map(cookieString)});res.end(JSON.stringify(data));};
  try{
   if(req.headers.host!==new URL(origin).host)return send({code:'invalid_context'},400);
   const url=new URL(req.url,origin),cookies=Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(v=>{const [k,...parts]=v.trim().split('=');return [k,decodeURIComponent(parts.join('='))];}));
   const ctx={origin:req.method==='POST'?req.headers.origin:origin,cookies};
   if(req.method==='GET'&&url.pathname==='/.well-known/eulab-connect.json'){const r=functionsResponse(connect.catalog);res.writeHead(r.status,Object.fromEntries(r.headers));return res.end(await r.text());}
   if(req.method==='GET'&&url.pathname==='/callback'){
    const r=await connect.auth.callback({state:url.searchParams.get('state')||'',code:url.searchParams.get('code')||undefined,error:url.searchParams.get('error')||undefined,iss:url.searchParams.get('iss')||undefined},ctx);
    res.writeHead(303,{location:origin+'/#handoff='+encodeURIComponent(r.handoff),'set-cookie':r.cookies.map(cookieString)});return res.end();
   }
   if(req.method==='GET'&&['/','/app.js'].includes(url.pathname)){res.setHeader('content-type',url.pathname==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');return res.end(await readFile(new URL(url.pathname==='/'?'./index.html':'./app.js',import.meta.url)));}
   if(req.method==='POST'){
    if(req.headers.origin!==origin)return send({code:'invalid_context'},403);
    let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>16384)return send({code:'invalid_input'},413);}
    const body=JSON.parse(raw||'{}');let result;
    switch(url.pathname){
     case '/auth/configuration':result=await connect.configuration.sync();break;
     case '/auth/sign-in':result=await connect.auth.signIn(body,ctx);break;
     case '/auth/migration':result=await connect.migration.submit(body,ctx);break;
     case '/auth/activation':result=await connect.activation.submit({...body,kind:'activation'},ctx);break;
     case '/auth/exchange':result=await connect.auth.exchange(body.handoff,ctx);break;
     case '/auth/refresh':result={session:await connect.auth.refresh(connect.auth.fromCookies(ctx))};break;
     case '/auth/logout':result=await connect.auth.logout(connect.auth.fromCookies(ctx),ctx);break;
     case '/projects':{
      const id=connect.auth.fromCookies(ctx),session=await connect.auth.resolve(id),tenantId=session.profile.localTenantId;
      const access=await connect.access.authorize(id,'projects.read',{tenantId});if(!access.allowed)return send({code:'access_denied'},403);
      // Central authorization is followed by a tenant predicate on every local data query.
      const projects=(await pool.query('SELECT id,name FROM workshop_projects WHERE tenant_id=$1',[tenantId])).rows;return send({projects});
     }
     default:return send({code:'not_found'},404);
    }
    const {cookies:directives=[],...publicResult}=result;
    // Session handles live in HttpOnly cookies; expose only the profile.
    if(publicResult.session)publicResult.session={profile:publicResult.session.profile,expiresAt:publicResult.session.expiresAt};
    return send(publicResult,200,directives);
   }
   return send({code:'not_found'},404);
  }catch(e){return send({code:e instanceof ConnectApplicationError?e.code:'request_failed'},400);}
 });
 server.listen(Number(new URL(origin).port||443),'127.0.0.1',()=>console.log('Workshop BFF ready on '+origin));
}
