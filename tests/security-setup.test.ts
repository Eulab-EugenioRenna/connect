import test from 'node:test';
import assert from 'node:assert/strict';
import {setupSecurity,flowAlias} from '../scripts/setup-security.mjs';
function fixture(){
 const calls:{path:string;method:string;body:any}[]=[],flowEntries=new Map<string,any[]>([[flowAlias,[]],[flowAlias+'-forms',[]]]);let providers=[{id:'eulab-connect-mfa'}],custom=false,unsafe=false;
 const realm:any={browserFlow:'browser',smtpServer:{host:'smtp.example.test',from:'no-reply@example.test'},attributes:{existing:'preserved'}};let created=false;
 const admin=async(path:string,method='GET',body?:any)=>{
  calls.push({path,method,body});
  if(!path){if(method==='PUT'){Object.assign(realm,body);return null;}return {...realm,browserFlow:custom?'custom-browser':realm.browserFlow};}
  if(path==='/authentication/authenticator-providers')return providers;
  if(path==='/identity-provider/instances')return [];
  if(path==='/clients?max=1000')return [{enabled:true,directAccessGrantsEnabled:unsafe}];
  if(path==='/authentication/required-actions')return [{alias:'CONFIGURE_TOTP',enabled:false}];
  if(path==='/authentication/required-actions/CONFIGURE_TOTP')return null;
  if(path==='/authentication/flows'){if(method==='POST'){created=true;return null;}return created?[{alias:flowAlias}]:[];}
  const match=path.match(/^\/authentication\/flows\/([^/]+)\/executions(.*)$/);if(!match)throw new Error('Unexpected path '+path);const [,parent,tail]=match;
  if(tail==='/execution'){flowEntries.get(parent)!.push({id:crypto.randomUUID(),providerId:body.provider,authenticationFlow:false,requirement:'DISABLED'});return null;}
  if(tail==='/flow'){flowEntries.get(parent)!.push({id:crypto.randomUUID(),authenticationFlow:true,displayName:body.alias,requirement:'DISABLED'});return null;}
  const own=flowEntries.get(parent)!;if(method==='PUT'){Object.assign(own.find(e=>e.id===body.id),body);return null;}
  return parent===flowAlias?[...own,...flowEntries.get(flowAlias+'-forms')!]:own;
 };
 return {admin,calls,realm,noProvider:()=>{providers=[];},custom:()=>{custom=true;},unsafe:()=>{unsafe=true;}};
}
test('Preparazione MFA: nessun binding anticipato, attivazione finale idempotente e attributi preservati',async()=>{
 const f=fixture();const prepared=await setupSecurity(f.admin);assert.equal(prepared.activated,false);assert.equal(f.realm.browserFlow,'browser');assert(!f.calls.some(c=>c.path===''&&c.method==='PUT'));
 const activated=await setupSecurity(f.admin,{activate:true});assert.equal(activated.activated,true);assert.equal(f.realm.browserFlow,flowAlias);assert.equal(f.realm.attributes.existing,'preserved');assert.equal(f.realm.attributes['eulab.previousBrowserFlow'],'browser');
 assert(!f.calls.some(c=>c.path.startsWith('/users')));const creates=f.calls.filter(c=>c.method==='POST').length;await setupSecurity(f.admin,{activate:true});assert.equal(f.calls.filter(c=>c.method==='POST').length,creates);
});
test('Attivazione MFA rifiutata se provider assente, flusso personalizzato o password grant attivo',async()=>{
 for(const kind of ['noProvider','custom','unsafe'] as const){const f=fixture();f[kind]();await assert.rejects(()=>setupSecurity(f.admin,{activate:true}));assert.equal(f.realm.browserFlow,'browser');assert(!f.calls.some(c=>c.method==='PUT'));}
});
test('Profilo MFA: configurazione idempotente, altri attributi e policy preservati',async()=>{
 const {setupSecurityProfile}=await import('../scripts/setup-security-profile.mjs');
 let profile:any={unmanagedAttributePolicy:'DISABLED',attributes:[{name:'username',required:{roles:['user']}}],groups:[{name:'existing'}]};
 const admin=async(path:string,method='GET',body?:any)=>{assert.equal(path,'/users/profile');if(method==='PUT')profile=body;return profile;};
 await setupSecurityProfile(admin);await setupSecurityProfile(admin);
 assert.equal(profile.attributes.length,2);assert.deepEqual(profile.attributes[0],{name:'username',required:{roles:['user']}});assert.equal(profile.unmanagedAttributePolicy,'DISABLED');assert.deepEqual(profile.groups,[{name:'existing'}]);
 assert.deepEqual(profile.attributes[1].permissions,{view:['admin'],edit:['admin']});assert.deepEqual(profile.attributes[1].validations.options.options,['auto','totp','email']);
});
