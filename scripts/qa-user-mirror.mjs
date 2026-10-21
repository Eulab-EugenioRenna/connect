import {chromium} from '@playwright/test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ConnectServer} from '../packages/sdk/dist/server.js';
process.loadEnvFile('.env');
const apiUrl='http://eulab-connect-mirror-qa:3000',servers=[],checks=[];let browser,token,customer,installation,appId,subject;
async function api(path,method='GET',body){const r=await fetch(apiUrl+path,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok,'API '+path+': '+r.status+' '+await r.clone().text());return r.json();}
try{
 for(const [port,host,target]of [[8088,'web',80],[8080,'keycloak',8080]]){const s=http.createServer((req,res)=>{const up=http.request({hostname:host,port:target,path:req.url,method:req.method,headers:{...req.headers,host:`localhost:${port}`}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});up.on('error',()=>{res.writeHead(502);res.end();});req.pipe(up);});await new Promise(r=>s.listen(port,'127.0.0.1',r));servers.push(s);}
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const p=await browser.newPage();p.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.status()===200)token=(await r.json()).access_token;});await p.goto('http://localhost:8088/');await p.getByRole('button',{name:'Accedi con EULab SSO'}).click();await p.locator('#username').fill(process.env.EULAB_ADMIN_USERNAME);await p.locator('#password').fill(process.env.EULAB_ADMIN_PASSWORD);await p.locator('#kc-login').click();await p.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();
 const suffix=randomUUID().slice(0,8);customer=(await api('/v1/customers','POST',{name:'Collaudo mirror '+suffix})).id;appId='qa-mirror-'+suffix;
 const i=await api('/v1/application-connections','POST',{id:appId,name:'App esistente QA',customerId:customer,domain:'http://localhost:5174',integration:'web'});installation=i.installationId;
 const sdk=new ConnectServer({apiUrl,installationId:installation,secret:i.secret});
 const local=Object.freeze({localUserId:'legacy-42',username:'qa-mirror-'+suffix,email:'qa-mirror-'+suffix+'@example.test',displayName:'Profilo Locale'});
 const mirrored=await sdk.mirrorUser(local);subject=mirrored.subject;assert.equal(mirrored.created,true);assert.equal(mirrored.ssoSetupRequired,true);assert.equal(mirrored.localUserId,local.localUserId);assert.equal(mirrored.customerId,customer);
 const twice=await sdk.mirrorUser({...local,displayName:'Non sovrascrivere'});assert.equal(twice.subject,subject);assert.equal(twice.status,'already_linked');
 const managed=(await api('/v1/sso-identities')).filter(u=>u.subject===subject);assert.equal(managed.length,1);assert.equal(managed[0].user_type,'client');assert.equal(managed[0].display_name,'Profilo Locale');assert.equal(managed[0].email,local.email);checks.push('SDK reale crea un’unica identità cliente in Keycloak e riutilizza il collegamento al retry');
 const overview=await api('/v1/overview');assert(overview.local_links.some(l=>l.installation_id===installation&&l.subject===subject&&l.local_user_id==='legacy-42'));assert(overview.memberships.some(m=>m.subject===subject&&m.customer_id===customer));assert.equal(overview.assignments.filter(a=>a.subject===subject).length,0);checks.push('ID locale preservato, appartenenza al solo tenant dell’installazione, nessun ruolo o permesso importato');
 await assert.rejects(()=>sdk.mirrorUser({...local,localUserId:'another-local',username:process.env.EULAB_ADMIN_USERNAME}),/409/);checks.push('Identità SSO già esistente protetta: nessuna fusione o sostituzione automatica');
 await mkdir('docs/verification/user-mirror',{recursive:true});await writeFile('docs/verification/user-mirror/result.json',JSON.stringify({status:'passed',at:new Date().toISOString(),realKeycloak:true,realPostgres:true,localApiContainer:true,productionDeployed:false,checks},null,2)+'\n');console.log(JSON.stringify({status:'passed',checks}));
}finally{
 if(token){if(subject)await api('/v1/sso-identities/'+subject,'DELETE');if(installation)await api('/v1/installations/'+installation,'DELETE');if(appId)await api('/v1/applications/'+appId,'DELETE');if(customer)await api('/v1/customers/'+customer,'DELETE');}
 if(browser)await browser.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}
}
