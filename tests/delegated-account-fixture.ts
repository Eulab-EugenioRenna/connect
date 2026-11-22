import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BadRequestException,ServiceUnavailableException} from '@nestjs/common';
// @ts-ignore JS harness
import {harness} from './harness.mjs';
import {defineFunctions} from '../packages/sdk/src/functions.js';
export async function delegatedAccountFixture(settings:any={}){
 const h=await harness(settings);
 const customer=(await h.request('/v1/customers','POST',{name:'Delegated customer'})).body;
 const site=(await h.request('/v1/application-connections','POST',{id:'delegated-app',name:'Delegated app',customerId:customer.id,domain:'https://delegated.test',integration:'web'})).body;
 h.setCatalogReader(async()=>defineFunctions({appId:'delegated-app',version:1,functions:[{key:'team.manage',name:'Team'},{key:'work.read',name:'Read'},{key:'work.write',name:'Write'}]}));
 assert.equal((await h.request('/v1/applications/delegated-app/catalog-sync','POST')).body.ok,true);
 await h.request('/v1/licenses','PUT',{customerId:customer.id,appId:'delegated-app',state:'active',expiresAt:null,features:['team.manage','work.read','work.write'].map(key=>({key,purchased:true,enabled:true})),reason:'Test'});
 const role=async(name:string,permissions:string[])=>(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'delegated-app',name,permissions,reason:'Test'})).body;
 const owner=await role('Owner',['team.manage','work.read']),worker=await role('Worker',['work.read']),power=await role('Power',['work.write']);
 await h.request('/v1/identities','PUT',{subject:'owner',displayName:'Owner',enabled:true});
 await h.request('/v1/memberships','PUT',{subject:'owner',customerId:customer.id,enabled:true,roleIds:[owner.id]});
 await h.request('/v1/identity-links','PUT',{installationId:site.installationId,localUserId:'local-owner',subject:'owner'});
 const source=(await h.request('/v1/connect-sources','POST',{id:'delegated-source',appId:'delegated-app',name:'Source',environment:'development',origins:['https://delegated.test'],deploymentIdentity:'deployment-test'})).body;
 assert.equal((await h.request('/v1/connect-sources/delegated-source/installations','POST',{installationId:site.installationId})).status,201);
 await h.store.query("INSERT INTO source_tenant_bindings(source_id,local_tenant_id,customer_id,app_id,local_name,local_slug) VALUES($1,$2,$3,$4,'Company','company')",['delegated-source','local-company',customer.id,'delegated-app']);
 await h.store.query("INSERT INTO app_local_users(source_id,installation_id,app_id,local_tenant_id,local_user_id,subject,email,email_normalized,role) VALUES($1,$2,'delegated-app','local-company','local-owner','owner','owner@example.test','owner@example.test','owner')",['delegated-source',site.installationId]);
 const headers={Authorization:'Bearer '+await h.token('owner',[]),'X-Installation-Id':site.installationId,'X-Installation-Secret':site.secret};
 const input={localUserId:'local-worker',username:'new.worker',email:'worker@example.test',displayName:'New Worker',initialPassword:'Transient-Test-Pass-9!',application:{sourceId:'delegated-source',localTenantId:'local-company',firstName:'New',lastName:'Worker',role:'collaborator',permissions:['work.read'],roleIds:[worker.id]}};
 const users=new Map<string,any>(),calls:any[]=[];let loseResponse=false,rejectPassword=false,rejectReset=false;
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{
  calls.push({path,method,body});
  if(path==='/users/profile')return {body:{attributes:settings.providerProfile===false?[]:['eulab_mirror_proof','eulab_app_mirror_profile'].map(name=>({name,permissions:{view:['admin'],edit:['admin']},multivalued:true}))}};
  if(path.startsWith('/users?')){const q=new URLSearchParams(path.split('?')[1]);if(q.has('username'))assert.equal(q.get('briefRepresentation'),'false','Recovery needs the provider proof attributes');return {body:[...users.values()].filter(u=>q.has('username')?u.username===q.get('username'):u.email===q.get('email'))};}
  if(path==='/users'&&method==='POST'){
   if(rejectPassword)throw new BadRequestException('Rejected password');
   const id=randomUUID();users.set(id,{...body,id});if(loseResponse){loseResponse=false;throw new ServiceUnavailableException('Lost response');}return {body:null,location:'https://provider.test/users/'+id};
  }
  if(path.includes('/execute-actions-email')){if(rejectReset)throw new ServiceUnavailableException('Uncertain delivery');return {body:null};}
  if(path.endsWith('/role-mappings/realm/composite'))return {body:users.get(path.split('/')[2])?.protected?[{name:'eulab-admin'}]:[]};
  if(path.endsWith('/credentials'))return {body:(users.get(path.split('/')[2])?.credentials||[]).map((c:any)=>({type:c.type}))};
  if(path.startsWith('/users/'))return {body:users.get(path.split('/')[2])};
  throw Error('Unexpected provider path');
 });
 if(settings.providerRequest)h.setIdentityRequest(settings.providerRequest);
 const mirror=(body:any=input,extra:any={})=>h.request('/v1/users/mirror','POST',body,{...headers,...extra});
 return {h,customer,site,source,owner,worker,power,input,headers,users,calls,mirror,set:(v:{loseResponse?:boolean;rejectPassword?:boolean;rejectReset?:boolean})=>{if(v.loseResponse!==undefined)loseResponse=v.loseResponse;if(v.rejectPassword!==undefined)rejectPassword=v.rejectPassword;if(v.rejectReset!==undefined)rejectReset=v.rejectReset;}};
}

