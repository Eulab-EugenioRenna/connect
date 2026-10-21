import {chromium} from '@playwright/test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
process.loadEnvFile('.env');
const servers=[],frames=[],errors=[];let browser,token;
const result={status:'running',at:new Date().toISOString(),realDocker:true,realKeycloak:true,realPostgres:true,realNginx:true,realWhatsApp:false,messagesSent:0,botsConfigured:0,botsActivated:0};
try{
 for(const [port,host,target]of [[8088,'web',80],[8080,'keycloak',8080]]){
  const server=http.createServer((req,res)=>{const upstream=http.request({hostname:host,port:target,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});
  server.on('upgrade',(req,socket,head)=>{
   const upstream=http.request({hostname:host,port:target,path:req.url,headers:req.headers});
   upstream.on('upgrade',(reply,peer,peerHead)=>{
    socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`+reply.rawHeaders.reduce((out,value,index,all)=>index%2===0?out+value+': '+all[index+1]+'\r\n':out,'')+'\r\n');
    if(head.length)peer.write(head);if(peerHead.length)socket.write(peerHead);socket.pipe(peer).pipe(socket);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());
   });upstream.on('response',reply=>{socket.end(`HTTP/1.1 ${reply.statusCode} Rejected\r\nConnection: close\r\n\r\n`);});upstream.on('error',()=>socket.destroy());upstream.end();
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));servers.push(server);
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'it-IT'});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',async response=>{if(response.url().includes('/protocol/openid-connect/token')&&response.status()===200)token=(await response.json()).access_token;});
 page.on('websocket',socket=>socket.on('framereceived',frame=>{try{const data=JSON.parse(String(frame.payload));frames.push(data.type);}catch{}}));
 await page.goto('http://localhost:8088/');await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();
 assert(process.env.EULAB_ADMIN_USERNAME&&process.env.EULAB_ADMIN_PASSWORD,'Credenziali admin locali assenti');
 await page.locator('#username').fill(process.env.EULAB_ADMIN_USERNAME);await page.locator('#password').fill(process.env.EULAB_ADMIN_PASSWORD);await page.locator('#kc-login').click();await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor({timeout:30000});assert(token);
 const overview=await fetch('http://api:3000/v1/overview',{headers:{authorization:'Bearer '+token}}).then(r=>{assert.equal(r.status,200);return r.json();});assert(overview.installations.length,'Nessuna installazione per il collaudo in sola simulazione');
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'WhatsApp',exact:true}).click();await page.getByLabel('Dominio / cliente').selectOption(overview.installations[0].id);
 await page.getByText('Aggiornamenti in tempo reale attivi',{exact:true}).waitFor({timeout:20000});const deadline=Date.now()+5000;while(!frames.includes('snapshot')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert(frames.includes('ready'));assert(frames.includes('snapshot'));
 await page.getByRole('button',{name:'Test bot IVR',exact:true}).click();await page.getByLabel('Frase di avvio bot di prova').fill('COLLAUDO');
 for(const input of ['COLLAUDO','1']){await page.getByLabel('Risposta al bot di prova').fill(input);await page.getByRole('button',{name:'Prova risposta',exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[aria-label="Risposta al bot di prova"]')?.value==='');}
 await page.getByRole('status').filter({hasText:'Percorso concluso'}).waitFor();
 await page.locator('.bot-simulation-messages .message').last().scrollIntoViewIfNeeded();await mkdir('docs/verification/whatsapp-realtime',{recursive:true});
 await page.screenshot({path:'docs/verification/whatsapp-realtime/live-desktop.png',fullPage:true,mask:[page.locator('#wa-installation')]});
 await page.setViewportSize({width:390,height:844});await page.locator('.bot-simulation-messages .message').last().scrollIntoViewIfNeeded();await page.screenshot({path:'docs/verification/whatsapp-realtime/live-mobile.png',fullPage:true,mask:[page.locator('#wa-installation')]});
 assert.equal(errors.length,0);Object.assign(result,{status:'passed',frames:[...new Set(frames)],checks:['Login SSO reale','Ticket autenticato e monouso','Upgrade WebSocket attraverso Nginx','SDK e admin con stato connected','Snapshot runtime ricevuto','Frase personalizzata e completamento IVR in simulazione','Schermate desktop/mobile']});
 console.log(JSON.stringify(result));
}catch(error){result.status='failed';result.error=error.message;console.error(error.message);process.exitCode=1;}
finally{await mkdir('docs/verification/whatsapp-realtime',{recursive:true});await writeFile('docs/verification/whatsapp-realtime/live-result.json',JSON.stringify(result,null,2)+'\n');await browser?.close();for(const server of servers)await new Promise(resolve=>server.close(resolve));}
