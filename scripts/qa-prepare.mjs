import {writeFile,mkdir} from 'node:fs/promises';
process.loadEnvFile('.env');
const kc='http://keycloak:8080';
async function response(url,options={}){const r=await fetch(url,options);if(!r.ok)throw new Error(`${options.method||'GET'} ${new URL(url).pathname}: ${r.status}`);const text=await r.text();return text?JSON.parse(text):null;}
const tokens=await response(kc+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KEYCLOAK_ADMIN,password:process.env.KEYCLOAK_ADMIN_PASSWORD})});
const headers={Authorization:`Bearer ${tokens.access_token}`,'content-type':'application/json'};
const admin=(path,method='GET',body)=>response(kc+'/admin/realms/eulab'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
const users={};
for(const [username,password,role]of [['qa-operator',process.env.QA_OPERATOR_PASSWORD,'eulab-admin'],['qa-customer',process.env.QA_CUSTOMER_PASSWORD,null]]){
 let [user]=await admin('/users?exact=true&username='+username);
 if(!user){await admin('/users','POST',{username,enabled:true,email:`${username}@example.test`,emailVerified:true,firstName:'Collaudo',lastName:username,credentials:[{type:'password',value:password,temporary:false}]});[user]=await admin('/users?exact=true&username='+username);}
 if(role){const definition=await admin('/roles/'+role);await admin(`/users/${user.id}/role-mappings/realm`,'POST',[definition]);}
 users[username]=user.id;
}
const [client]=await admin('/clients?clientId=connect-wordpress');
const definition=await admin('/clients/'+client.id);
await admin('/clients/'+client.id,'PUT',{...definition,redirectUris:[...new Set([...(definition.redirectUris||[]),'http://localhost:8090/?eulab_sso_callback=1'])],webOrigins:['http://localhost:8090']});
await mkdir('docs/verification',{recursive:true});await writeFile('docs/verification/qa-identities.json',JSON.stringify({createdAt:new Date().toISOString(),users,wordpressClientConfigured:true},null,2)+'\n');
console.log('Identità QA e callback WordPress configurati in Keycloak reale.');
