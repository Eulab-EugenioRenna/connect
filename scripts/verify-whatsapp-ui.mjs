import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {harness} from '../tests/harness.mjs';
const h=await harness();
h.setIdentityRequest(async path=>{
 if(path==='/client-session-stats')return {body:[{id:'admin',active:'2'}]};
 if(path.startsWith('/clients/admin/'))return {body:[{id:'session-anna',userId:'anna',username:'anna',start:Date.now(),lastAccess:Date.now(),clients:{admin:'connect-admin'}},{id:'session-luca',userId:'luca',username:'luca',start:Date.now(),lastAccess:Date.now(),clients:{admin:'connect-admin'}}]};
 if(path.startsWith('/users?'))return {body:[{id:'anna',username:'anna',firstName:'Anna',enabled:true},{id:'luca',username:'luca',firstName:'Luca',enabled:true},{id:'other',username:'other',firstName:'Utente esterno',enabled:true}]};
 return {body:[]};
});
let browser,page;const diagnostics=[];
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')diagnostics.push(m.text());});page.on('requestfailed',r=>diagnostics.push(`${new URL(r.url()).origin}${new URL(r.url()).pathname}: ${r.failure()?.errorText}`));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin==='https://oidc.test'){
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'https://connect.test','access-control-allow-methods':'POST,GET,OPTIONS','access-control-allow-headers':'content-type'}});
   const response=await h.oidcFetch(req.url(),{body:req.postData()||''});if(response.status===302)return route.fulfill({contentType:'text/html',body:`<script>location.replace(${JSON.stringify(response.headers.get('location'))})</script>`});
   return route.fulfill({status:response.status,headers:{...Object.fromEntries(response.headers),'access-control-allow-origin':'https://connect.test'},body:await response.text()});
  }
  if(url.origin!=='https://connect.test')return route.abort();
  if(url.pathname.startsWith('/v1/')){const response=await h.injectRequest(url.pathname+url.search,req.method(),req.postData()?JSON.parse(req.postData()):undefined,req.headers());return route.fulfill({status:response.status,headers:{'content-type':'application/json'},body:response.text});}
  if(url.pathname==='/config.js')return route.fulfill({contentType:'application/javascript',body:`window.EULAB_CONFIG=${JSON.stringify({apiUrl:'',issuer:h.issuer,clientId:'connect-admin'})}`});
  const path=url.pathname==='/'?'/index.html':url.pathname;
  const file=resolve('dist/web','.'+path);if(!file.startsWith(resolve('dist/web')+'/'))return route.abort();
  const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
  try{return route.fulfill({contentType:type,body:await readFile(file)});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('https://connect.test/');await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();
 await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'WhatsApp',exact:true}).waitFor();const workspace=await page.locator('.workspace').boundingBox();assert(workspace.y<5);assert.equal(await page.locator('.brand-logo').evaluate(img=>img.complete&&img.naturalWidth>0),true);
 await page.getByRole('button',{name:'Aziende clienti',exact:true}).click();await page.getByRole('button',{name:'Nuova azienda'}).click();
 await page.getByLabel('Ragione sociale',{exact:true}).fill('Cliente di verifica');await page.getByLabel('Riferimento interno').fill('Collaudo locale');await page.getByRole('button',{name:'Conferma',exact:true}).click();
 await page.getByRole('cell',{name:'Cliente di verifica',exact:true}).waitFor();
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'App e siti',exact:true}).click();await page.getByRole('button',{name:'Aggiungi app'}).click();
 await page.getByLabel('Nome applicazione',{exact:true}).fill('Portale WordPress');await page.getByLabel('Dominio autorizzato').fill('https://wp.example');await page.getByLabel('Descrizione',{exact:true}).fill('Sito collegato del cliente');await page.getByLabel('Tipo applicazione').selectOption('wordpress');
 await page.getByLabel('Sottocartella del sito').fill('/blog');await page.getByRole('button',{name:'Conferma',exact:true}).click();
 await page.getByRole('heading',{name:'Configurazione generata'}).waitFor();await page.getByRole('button',{name:'Chiudi',exact:true}).click();
 await page.getByRole('cell',{name:/https:\/\/wp.example\/blog/}).waitFor();await page.getByRole('button',{name:'Utenti e accesso',exact:true}).waitFor();

 const overview=(await h.request('/v1/overview')).body,installation=overview.installations[0].id;
 const archive=crypto.randomUUID();await h.store.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3)',[archive,installation,'393331234567']);
 const session=crypto.randomUUID();await h.store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,state,archive_id,number) VALUES($1,$2,'ui-test','connected',$3,'393331234567')",[session,installation,archive]);
 const avatar='data:image/png;base64,'+(await readFile('apps/web/public/whatsapp-test/image.png')).toString('base64');
 await h.store.query('INSERT INTO wa_contacts(archive_id,chat_id,profile) VALUES($1,$2,$3)',[archive,'393332222222@c.us',JSON.stringify({name:'Anna Rossi',pushName:'Anna',description:'Referente acquisti · EULab',avatar,isBusiness:true,isGroup:false})]);
 await h.store.query("INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body,occurred_at) VALUES($1,$2,$3,'ui-msg-1','393332222222@c.us','in','chat',$4,now())",[crypto.randomUUID(),session,archive,JSON.stringify({text:'Buongiorno! Vorrei informazioni sui vostri servizi.',senderName:'Anna'})]);
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'WhatsApp',exact:true}).click();
 await page.getByLabel('Dominio / cliente').selectOption(installation);
 await page.getByLabel('Numero destinatario').fill('+39 333 1234567');
 for(const kind of ['text','image','document','audio','video','poll','interactive']){
  await page.getByLabel('Tipo di messaggio',{exact:true}).selectOption(kind);
  if(['text','poll','interactive'].includes(kind))await page.getByLabel('Testo messaggio').fill('Prova messaggio');
  if(kind==='poll')await page.getByLabel('Opzioni sondaggio').fill('Uno\nDue');
  if(['image','document','audio','video'].includes(kind))await page.getByText('Selezionato:',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Verifica senza inviare'}).click();
  await page.getByRole('status').filter({hasText:'Nessun messaggio inviato'}).waitFor();
 }
 await page.getByRole('heading',{name:'Anna Rossi',exact:true}).waitFor();
 assert.equal(await page.locator('.wa-conversation-heading .wa-avatar img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
 await mkdir('docs/verification/openwaunlocked',{recursive:true});
 await page.screenshot({path:'docs/verification/openwaunlocked/conversations-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Conversazioni: overflow orizzontale mobile');
 assert.equal(await page.getByLabel('Scelte interattive').inputValue(),'info|Informazioni\nappointment|Appuntamento\nsupport|Assistenza\nprices|Prezzi');
 await page.getByRole('button',{name:'Invia messaggio',exact:true}).scrollIntoViewIfNeeded();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.screenshot({path:'docs/verification/openwaunlocked/conversations-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1050});
 await page.getByRole('button',{name:'Chiamate WhatsApp',exact:true}).click();
 await page.getByText('Coming soon',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Avvia chiamata',exact:true}).count(),0);
 await page.getByRole('button',{name:'Test bot IVR',exact:true}).click();
 await page.getByRole('button',{name:'Prova risposta',exact:true}).click();
 await page.getByRole('button',{name:'Prezzi e servizi',exact:true}).waitFor();
 await page.getByRole('button',{name:'Prezzi e servizi',exact:true}).click();
 await page.getByRole('status').filter({hasText:'information'}).waitFor();
 await page.getByRole('button',{name:'Simulazione vocale / DTMF',exact:true}).click();
 await page.getByRole('button',{name:'Prova risposta',exact:true}).click();
 await page.getByRole('button',{name:'2 · Appuntamento',exact:true}).waitFor();
 await page.getByRole('button',{name:'2 · Appuntamento',exact:true}).click();
 await page.getByText('Come ti chiami?',{exact:true}).last().waitFor();
 await page.screenshot({path:'docs/verification/openwaunlocked/ivr-voice-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Pulsanti WhatsApp',exact:true}).click();
 await page.getByLabel('Frase di avvio bot di prova').fill('PRENOTA');
 await page.getByLabel('Risposta al bot di prova').fill('messaggio diverso');await page.getByRole('button',{name:'Prova risposta',exact:true}).click();
 await page.getByText('Nessuna risposta: il messaggio non attiva il bot.',{exact:true}).waitFor();
 for(const input of ['PRENOTA','2','Eugenio','1','Martedì']){
  await page.getByLabel('Risposta al bot di prova').fill(input);await page.getByRole('button',{name:'Prova risposta',exact:true}).click();
  await page.getByRole('button',{name:'Prova risposta',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('input[aria-label="Risposta al bot di prova"]')?.value==='');
 }
 await page.getByRole('status').filter({hasText:'appointment_requested'}).waitFor();
 assert.equal((await h.store.query('SELECT * FROM outbox')).length,0);assert.equal((await h.store.query('SELECT * FROM wa_bots')).length,0);
 await mkdir('docs/verification/whatsapp-messages',{recursive:true});
 await page.locator('.bot-simulation-messages .message').last().scrollIntoViewIfNeeded();
 await page.screenshot({path:'docs/verification/whatsapp-messages/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.locator('.bot-simulation-messages .message').last().scrollIntoViewIfNeeded();await page.screenshot({path:'docs/verification/whatsapp-messages/mobile.png',fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));console.log('OpenWAUnlocked: sette tipi, pulsanti IVR, voce/DTMF, Coming soon e conversazioni desktop/mobile verificati. Nessun invio reale.');
}finally{await browser?.close();await h.close();}
