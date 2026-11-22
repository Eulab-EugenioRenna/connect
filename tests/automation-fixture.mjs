import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {harness} from './harness.mjs';
import {hash} from '../dist/server/apps/api/src/security.js';
export async function automationFixture(settings={}){
 const databaseUrl=process.env.CONNECT_AUTOMATION_TEST_DATABASE_URL;
 if(databaseUrl){const url=new URL(databaseUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/connect_automation_synthetic');}
 const h=await harness({...settings,...databaseUrl?{databaseUrl}:{}}),customer=randomUUID(),installation=randomUUID(),otherInstallation=randomUUID(),archive=randomUUID(),session=randomUUID(),role=randomUUID(),actor='synthetic-automation-author',secret='synthetic-installation-credential';
 const q=h.store.query;
 process.env.OIDC_IDENTITY_ADMIN_SECRET='synthetic-provider-service-secret';
 const providerUsers=new Map([[actor,{id:actor,enabled:true}],['synthetic-other-author',{id:'synthetic-other-author',enabled:true}]]);
 let identityUnavailable=false,beforeProviderRead=async()=>{};
 const providerFetch=globalThis.fetch;
 globalThis.fetch=async(input,options={})=>{
  const url=String(input),params=new URLSearchParams(options.body||'');
  if(url===h.issuer+'/protocol/openid-connect/token'&&params.get('client_id')==='connect-identity-admin')return Response.json({access_token:'synthetic-service-token',expires_in:300});
  if(url.startsWith(h.issuer.replace('/realms/','/admin/realms/')+'/users/')){
   assert.equal(options.method,'GET');if(identityUnavailable)return Response.json({},{status:503});
   await beforeProviderRead();
   const user=providerUsers.get(decodeURIComponent(url.split('/').at(-1)));return Response.json(user||{},{status:user?200:404});
  }
  return providerFetch(input,options);
 };

 await q("INSERT INTO customers(id,name) VALUES($1,'Synthetic automation customer')",[customer]);
 await q("INSERT INTO applications(id,name) VALUES('synthetic-automation','Synthetic application')");
 await q("INSERT INTO identities(subject,display_name) VALUES($1,'Synthetic author'),('synthetic-other-author','Other synthetic author')",[actor]);
 await q("INSERT INTO memberships(subject,customer_id) VALUES($1,$2),('synthetic-other-author',$2)",[actor,customer]);
 for(const id of [installation,otherInstallation]){
  await q("INSERT INTO installations(id,customer_id,app_id,domain,fallback_url,secret_hash) VALUES($1,$2,'synthetic-automation','https://synthetic.example.test','https://synthetic.example.test/functions',$3)",[id,customer,hash(secret)]);
  await q("INSERT INTO local_links(installation_id,local_user_id,subject) VALUES($1,'synthetic-user',$2),($1,'synthetic-other','synthetic-other-author')",[id,actor]);
 }
 await q("INSERT INTO licenses(customer_id,app_id,state) VALUES($1,'synthetic-automation','active')",[customer]);
 await q("INSERT INTO features(app_id,key,name) VALUES('synthetic-automation','whatsapp','WhatsApp'),('synthetic-automation','appointments','Appointments')");
 for(const [permission,feature] of [['whatsapp.manage','whatsapp'],['whatsapp.send','whatsapp'],['appointments.notify','appointments'],['appointments.email','appointments']])await q("INSERT INTO permissions(app_id,key,name,feature_key) VALUES('synthetic-automation',$1,$1,$2)",[permission,feature]);
 await q("INSERT INTO entitlements(customer_id,app_id,feature_key,purchased,enabled) VALUES($1,'synthetic-automation','whatsapp',true,true),($1,'synthetic-automation','appointments',true,true)",[customer]);
 await q("INSERT INTO roles(id,customer_id,app_id,name) VALUES($1,$2,'synthetic-automation','Synthetic operator')",[role,customer]);
 for(const permission of ['whatsapp.manage','whatsapp.send','appointments.notify','appointments.email'])await q("INSERT INTO role_permissions VALUES($1,'synthetic-automation',$2)",[role,permission]);
 await q("INSERT INTO assignments(subject,customer_id,app_id,role_id) VALUES($1,$2,'synthetic-automation',$3),('synthetic-other-author',$2,'synthetic-automation',$3)",[actor,customer,role]);
 await q("INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,'15550000001')",[archive,installation]);
 await q("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'synthetic-runner',$3,'15550000001','connected')",[session,installation,archive]);
 const token=await h.token(actor,[]),personal={'X-Installation-Id':installation,'X-Installation-Secret':secret,Authorization:'Bearer '+token},server={...personal,Authorization:''},root=`/v1/installations/${installation}/automations`;
 const input={purpose:'appointments.reminder',channel:'whatsapp',functions:['whatsapp.manage','whatsapp.send'],archiveId:archive,expiresAt:new Date(Date.now()+86400000).toISOString()};
 const create=(body=input,key='synthetic-grant-001',headers=personal)=>h.request(root+'/delegations','POST',body,{...headers,'Idempotency-Key':key});
 const grant=(await create()).body;assert(grant.credential,JSON.stringify(grant));
 const delegated={...server,'X-Connect-Delegation':grant.credential};
 const message={purpose:input.purpose,sessionId:session,payload:{kind:'text',to:'15550000002@c.us',text:'Synthetic appointment reminder'}};
 const send=(body=message,key='synthetic-message-001',headers=delegated,id=grant.delegation.id)=>h.request(root+`/delegations/${id}/messages`,'POST',body,{...headers,'Idempotency-Key':key});
 return {...h,q,providerUsers,setBeforeProviderRead:fn=>{beforeProviderRead=fn;},setIdentityUnavailable:v=>{identityUnavailable=v;},customer,installation,otherInstallation,archive,session,role,actor,secret,personal,server,delegated,root,input,create,grant,message,send};
}
