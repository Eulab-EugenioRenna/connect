import {chromium} from '@playwright/test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
process.loadEnvFile('.env');
const mode=process.argv[2]||'prepare',output='docs/verification/wordpress-mu',configPath='.guardian.qa.json';
let token,config;
async function api(path,method='GET',body){const r=await fetch('http://api:3000'+path,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok,'API '+path+': '+r.status);return r.status===204?null:r.json();}
await mkdir(output,{recursive:true});
if(mode==='prepare'){
 const servers=[];let browser;
 try{
  for(const [port,host,target]of [[8088,'web',80],[8080,'keycloak',8080]]){const s=http.createServer((req,res)=>{const up=http.request({hostname:host,port:target,path:req.url,method:req.method,headers:{...req.headers,host:`localhost:${port}`}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});up.on('error',()=>{res.writeHead(502);res.end();});req.pipe(up);});await new Promise(r=>s.listen(port,'127.0.0.1',r));servers.push(s);}
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const p=await browser.newPage();p.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.status()===200)token=(await r.json()).access_token;});await p.goto('http://localhost:8088/');await p.getByRole('button',{name:'Accedi con EULab SSO'}).click();await p.locator('#username').fill(process.env.EULAB_ADMIN_USERNAME);await p.locator('#password').fill(process.env.EULAB_ADMIN_PASSWORD);await p.locator('#kc-login').click();await p.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();
  const overview=await api('/v1/overview'),i=overview.installations.find(i=>i.domain==='http://localhost:8090');assert(i);const old=await readFile(configPath,'utf8').then(JSON.parse).catch(()=>null);const enrolled=old?.installationId===i.id?old:await api('/v1/wordpress-guardians/'+i.id,'POST');await writeFile(configPath,JSON.stringify({apiUrl:'http://api:3000',installationId:i.id,secret:enrolled.secret,adminToken:token}),{mode:0o600});
  await p.getByRole('navigation').getByRole('button',{name:'Applicazioni',exact:true}).click();await p.getByRole('button',{name:'Siti WordPress',exact:true}).click();await p.getByRole('button',{name:'Protezione plugin',exact:true}).click();await p.getByText('Ripristino:',{exact:false}).waitFor();await p.screenshot({path:output+'/admin-protection.png',fullPage:true});console.log('Configurazione privata MU preparata.');
 }finally{if(browser)await browser.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}}
}else{
 config=JSON.parse(await readFile(configPath,'utf8'));token=config.adminToken;const root='/v1/wordpress-guardians/'+config.installationId;
 if(mode==='stop'||mode==='resume'){await api(root,'PUT',{enabled:mode==='resume'});console.log('Policy '+mode+' salvata.');}
 else{const r=await fetch('http://qa-wordpress/index.php?eulab_catalog=1',{headers:{host:'localhost:8090'},redirect:'manual'});const json=(r.headers.get('content-type')||'').includes('application/json');if(mode==='paused')assert.equal(json,false);else{assert.equal(json,true);const matrix=await r.json();assert(matrix.functions.some(f=>f.key==='whatsapp.send'));}const status=await api(root);assert.equal(status.enabled,mode!=='paused');await writeFile(output+'/'+mode+'.json',JSON.stringify({status:'passed',at:new Date().toISOString(),central:status},null,2)+'\n');console.log(JSON.stringify({status:'passed',phase:mode,pluginResponds:json,repairs:status.repairs}));}
}
