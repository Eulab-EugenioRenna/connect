import {chromium} from '@playwright/test';
import http from 'node:http';
import {writeFile} from 'node:fs/promises';
process.loadEnvFile('.env');
const servers=[];let browser,token;
try{
 for(const [port,host,target]of [[8088,'web',80],[8080,'keycloak',8080]]){const server=http.createServer((req,res)=>{const p=http.request({hostname:host,port:target,path:req.url,method:req.method,headers:{...req.headers,host:`localhost:${port}`}},u=>{res.writeHead(u.statusCode,u.headers);u.pipe(res);});p.on('error',()=>{res.writeHead(502);res.end();});req.pipe(p);});await new Promise(r=>server.listen(port,'127.0.0.1',r));servers.push(server);}
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});const page=await browser.newPage();page.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.status()===200){const t=await r.json();token=t.access_token;}});
 await page.goto('http://localhost:8088/');await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();await page.locator('#username').fill('qa-operator');await page.locator('#password').fill(process.env.QA_OPERATOR_PASSWORD);await page.locator('#kc-login').click();await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();
 const root=`http://api:3000/v1/installations/${process.env.QA_INSTALLATION_ID}/whatsapp`;
 async function request(path,method='GET'){const r=await fetch(root+path,{method,headers:{Authorization:`Bearer ${token}`}});const value=await r.json();if(!r.ok)throw new Error(`${path}: ${r.status} ${JSON.stringify(value)}`);return value;}
 let session=(await request('/sessions')).find(s=>!s.closed_at);
 if(!session)session=await request('/sessions','POST');else if(session.state==='failed')await request(`/sessions/${session.id}/reconnect`,'POST');
 let status;
 for(let n=0;n<45;n++){
  status=await request(`/sessions/${session.id}/qr`);
  if(status.qr||status.state==='connected'||status.state==='failed')break;
  await new Promise(r=>setTimeout(r,2000));
 }
 let qrRenderedInDashboard=false;
 if(status.qr){
  await page.getByRole('button',{name:'WhatsApp',exact:true}).click();await page.locator('#wa-installation').selectOption(process.env.QA_INSTALLATION_ID);
  await page.getByRole('button',{name:'Mostra QR',exact:true}).last().click();await page.locator('img.qr').waitFor();qrRenderedInDashboard=true;
  await page.locator('.page-enter').evaluateAll(elements=>Promise.all(elements.flatMap(el=>el.getAnimations().map(a=>a.finished.catch(()=>{})))));
  await page.screenshot({path:'docs/verification/whatsapp-qr-masked.png',fullPage:true,mask:[page.locator('img.qr')]});
 }
 const result={at:new Date().toISOString(),sessionId:session.id,state:status.state,qrAvailable:!!status.qr,qrRenderedInDashboard,provider:'openwaunlocked',providerVersion:'1.0.0',buttonsVerified:false,messagesSent:0};
 await writeFile('docs/verification/openwa-status.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 if(!status.qr&&status.state!=='connected')process.exitCode=1;
}finally{if(browser)await browser.close();for(const s of servers)await new Promise(r=>s.close(r));}
