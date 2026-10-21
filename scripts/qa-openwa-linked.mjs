import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';

process.loadEnvFile('.env');
const docker=process.env.QA_DOCKER==='true',servers=[];
const result={at:new Date().toISOString(),status:'running',realKeycloak:true,realOpenWa:true,checks:[],agentSendRequests:0};
let browser;
const output='docs/verification';await mkdir(output,{recursive:true});
try{
 if(docker)for(const [port,host,target]of [[8088,'web',80],[8080,'keycloak',8080]]){
  const server=http.createServer((req,res)=>{const upstream=http.request({hostname:host,port:target,path:req.url,method:req.method,headers:{...req.headers,host:`localhost:${port}`}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));servers.push(server);
 }
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'it-IT'});let token;
 page.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.status()===200)token=(await r.json()).access_token;});
 await page.goto('http://localhost:8088/');await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();
 await page.locator('#username').fill(process.env.EULAB_ADMIN_USERNAME);await page.locator('#password').fill(process.env.EULAB_ADMIN_PASSWORD);await page.locator('#kc-login').click();
 await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();assert(token);
 const root=`${docker?'http://api:3000':'http://localhost:8088'}/v1/installations/${process.env.QA_INSTALLATION_ID}/whatsapp`;
 async function request(path,method='GET',body,headers={}){
  const r=await fetch(root+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(!r.ok)throw new Error(`WhatsApp ${method}: HTTP ${r.status}`);return r.json();
 }
 let session=(await request('/sessions')).find(s=>!s.closed_at);assert(session,'Sessione attiva assente');
 assert.equal(session.state,'connected');assert.equal(session.runner_online,true);
 result.sessionId=session.id;result.archiveId=session.archive_id;result.runner=session.runner_id;
 const qr=await request(`/sessions/${session.id}/qr`);assert.equal(qr.qr,null);
 result.checks.push('Sessione connessa su runner online, QR rimosso e archivio disponibile');
 if(process.argv.includes('--send-self')){
  const suffix=process.argv.find(a=>a.startsWith('--suffix='))?.split('=')[1];
  const testId=process.argv.find(a=>a.startsWith('--test-id='))?.split('=')[1];
  assert(suffix&&/^\d{4}$/.test(suffix)&&session.number.endsWith(suffix),'Destinatario diverso dal numero autorizzato');
  assert(testId&&/^[a-zA-Z0-9_-]{8,128}$/.test(testId),'Chiave idempotenza esplicita richiesta');
  const queued=await request(`/sessions/${session.id}/messages`,'POST',{kind:'text',to:`${session.number}@c.us`,text:'Test EULab: collegamento verificato'},{'idempotency-key':testId});
  result.agentSendRequests=1;result.outboxId=queued.id;
  for(let i=0;i<60;i++){
   const item=(await request('/outbox')).find(o=>o.id===queued.id);result.sendState=item?.state;
   if(item&&['sent','uncertain','failed','cancelled'].includes(item.state)){result.providerConfirmed=!!item.provider_id;break;}
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(result.sendState,'sent','Invio non confermato: nessun reinvio automatico');assert.equal(result.providerConfirmed,true);
  result.checks.push('Unico messaggio di prova autorizzato inviato al proprio numero; ID provider confermato');
 }
 for(let i=0;i<150;i++){
  session=(await request('/sessions')).find(s=>s.id===session.id);
  result.state=session.state;result.syncStatus=session.sync_status;result.syncCount=session.sync_count;
  if(session.sync_status!=='running')break;
  if(i%10===0)console.log(JSON.stringify({state:session.state,syncStatus:session.sync_status,syncCount:session.sync_count}));
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 assert.equal(session.state,'connected');assert.equal(session.sync_status,'available_history_synced');assert(session.sync_count>0);
 result.checks.push('Storico disponibile sincronizzato con conteggio maggiore di zero');
 await page.getByRole('button',{name:'WhatsApp',exact:true}).click();await page.locator('#wa-installation').selectOption(process.env.QA_INSTALLATION_ID);
 await page.getByText('Connessa',{exact:true}).waitFor();
 await page.locator('.page-enter').evaluateAll(elements=>Promise.all(elements.flatMap(el=>el.getAnimations().map(a=>a.finished.catch(()=>{})))));
 await page.screenshot({path:`${output}/openwa-connected-masked.png`,fullPage:true,mask:[page.locator('td.title-cell'),page.locator('tr:has(td.mono) td:last-child')]});
 result.checks.push('Dashboard reale mostra Connessa e avanzamento dello storico');
 result.status='passed';console.log(JSON.stringify(result,null,2));
}catch(error){result.status='failed';result.error=error.message;console.log(JSON.stringify(result,null,2));process.exitCode=1;}
finally{await writeFile(`${output}/openwa-linked-fix-result.json`,JSON.stringify(result,null,2)+'\n');if(browser)await browser.close();for(const server of servers)await new Promise(resolve=>server.close(resolve));}
