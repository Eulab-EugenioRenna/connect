import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OpenWaAdapter,NotSent,Unconfirmed,NotOnWhatsApp,providerReason,openChatInPage,mediaSource,decryptMediaBytes} from '../apps/runner/src/openwa.js';
OpenWaAdapter.verify={afterResultMs:60,afterErrorMs:40,ackMs:60};

const sessionId='00000000-0000-0000-0000-000000000001';
async function fixture(run:(context:any)=>Promise<void>){
 const directory=await mkdtemp(path.join(tmpdir(),'connect-unlocked-'));
 const previous={profile:process.env.OPENWA_PROFILE_DIR,key:process.env.DATA_ENCRYPTION_KEY};
 process.env.OPENWA_PROFILE_DIR=directory;process.env.DATA_ENCRYPTION_KEY='ab'.repeat(32);
 const events=new EventEmitter(),stops:string[]=[],calls:any[]=[];
 let config:any,startError:Error|undefined,result:unknown='true_123@c.us_message';
 // The phone: what OpenWA reports after a send. appear=false: nothing left; ack: what WhatsApp answers.
 const phone:any={appear:true,ack:1,onMessage:()=>{},onAck:()=>{},count:0,
  echo(type:string,to:string,extra:any){
   if(!phone.appear)return;const id=typeof result==='string'&&result.startsWith('true_')?result:`true_${to}_m${++phone.count}`;
   setTimeout(()=>{phone.onMessage({id,fromMe:true,type,to,ack:0,...extra});if(phone.ack!==null)setTimeout(()=>phone.onAck({id,ack:phone.ack,fromMe:true}),1);},1);
  }};
 class Driver {}
 class Client {
  constructor(options:any){assert.equal(options.transport,'transport');}
  async start(){
   if(config.linkCode)events.emit('launch.auth.linkCode.generated',{details:{linkCode:'ab12cd34'}});
   else events.emit('launch.auth.qr.generated',{details:{qr:'fixture-qr'}});
   if(startError)throw startError;
  }
  async stop(reason:string){stops.push(reason);}
  async onAnyMessage(fn:any){phone.onMessage=fn;}
  async onAck(fn:any){phone.onAck=fn;}
  async onStateChanged(){}
  async checkNumberStatus(to:string){calls.push(['check',to]);return phone.exists===false?{id:to,status:404,canReceiveMessage:false}:{id:to,status:200,numberExists:true,canReceiveMessage:true};}
  async getMessageById(){return {ack:2};}
  async sendInteractive(...args:any[]){calls.push(['interactive',...args]);return result;}
  async sendText(...args:any[]){calls.push(['text',...args]);phone.echo('chat',args[0],{body:args[1]});if(result instanceof Error)throw result;return result;}
  async sendFile(...args:any[]){calls.push(['file',...args]);phone.echo('image',args[0],{caption:args[3]?.caption??''});if(result instanceof Error)throw result;return result;}
  async sendPoll(...args:any[]){calls.push(['poll',...args]);phone.echo('poll_creation',args[0],{});return result;}
  async evaluate(fn:any,arg:any){return fn(arg);}
 }
 class Adapter extends OpenWaAdapter {
  protected async loadProvider(){return [
   {createClient:async(options:any)=>{config=options;return {events,getTransport:()=> 'transport'};}},
   {Client},{PuppeteerDriver:Driver},{default:{toDataURL:async(value:string)=>'data:image/png;base64,'+value}}
  ];}
 }
 const adapter=new Adapter();
 try{await run({adapter,directory,events,stops,calls,phone,config:()=>config,setError:(error:Error)=>{startError=error;},setResult:(value:unknown)=>{result=value;},Driver});}
 finally{
  if(previous.profile===undefined)delete process.env.OPENWA_PROFILE_DIR;else process.env.OPENWA_PROFILE_DIR=previous.profile;
  if(previous.key===undefined)delete process.env.DATA_ENCRYPTION_KEY;else process.env.DATA_ENCRYPTION_KEY=previous.key;
  await rm(directory,{recursive:true,force:true});
 }
}

test('OpenWAUnlocked: crea il client, converte il QR e conserva i vecchi profili',async()=>fixture(async({adapter,directory,config,events,Driver})=>{
 const old=path.join(directory,sessionId,'v5','checkpoint');await mkdir(path.dirname(old),{recursive:true});await writeFile(old,'preserved');
 let qr='';await adapter.create(sessionId,async(value:string)=>{qr=value;});
 assert.equal(qr,'data:image/png;base64,fixture-qr');
 assert(config().driver instanceof Driver);
 assert.equal(config().sessionDataPath,path.join(directory,sessionId,'openwaunlocked'));
 assert.equal(config().sessionDataEncryptionKey,Buffer.from('ab'.repeat(32),'hex').toString('base64'));
 assert.equal(config().userDataDir,undefined);assert.equal(config().licenseKey,undefined);
 assert.equal(events.listenerCount('launch.auth.qr.generated'),0);
 assert.equal(await readFile(old,'utf8'),'preserved');
}));

test('OpenWAUnlocked: un avvio fallito chiude il client e rimuove listener e avvio pendente',async()=>fixture(async({adapter,setError,events,stops})=>{
 setError(new Error('START_FAILED'));
 await assert.rejects(adapter.create(sessionId,async()=>{}),/START_FAILED/);
 assert.deepEqual(stops,['eulab-start-failed']);
 assert.equal(events.listenerCount('launch.auth.qr.generated'),0);
 await adapter.cancelPending(sessionId);assert.equal(stops.length,1);
}));

test('OpenWAUnlocked: collegamento con numero, codice da digitare sul telefono al posto del QR',async()=>fixture(async({adapter,config})=>{
 let qr='',code='';
 await adapter.create(sessionId,async(value:string)=>{qr=value;},{phone:'+39 333 123 4567',onLinkCode:async(value:string)=>{code=value;}});
 assert.equal(config().linkCode,'393331234567');
 await new Promise(r=>setImmediate(r));
 assert.equal(code,'AB12CD34');assert.equal(qr,'');
}));

test('OpenWAUnlocked: gli invii dello stesso numero partono uno alla volta',async()=>fixture(async({adapter,calls})=>{
 const client=await adapter.create(sessionId,async()=>{});
 let active=0,peak=0;const original=client.sendFile;
 client.sendFile=async(...args:any[])=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return original(...args);};
 await Promise.all([1,2,3,4].map(()=>adapter.send(client,{kind:'image',to:'123@c.us',data:'data:image/png;base64,AA==',filename:'p.png'})));
 assert.equal(peak,1);assert.equal(calls.filter(c=>c[0]==='file').length,4);
}));

test('OpenWAUnlocked: media e sondaggi conservano parametri e ID, true resta non confermato, false è un rifiuto',async()=>fixture(async({adapter,calls,setResult})=>{
 const client=await adapter.create(sessionId,async()=>{});
 const id=await adapter.send(client,{kind:'image',to:'123@c.us',data:'data:image/png;base64,AA==',filename:'photo.png',caption:'Foto'});
 assert.equal(id,'true_123@c.us_message');
 assert.deepEqual(calls.filter(c=>c[0]!=='check')[0],['file','123@c.us','data:image/png;base64,AA==','photo.png',{caption:'Foto'}]);
 await adapter.send(client,{kind:'poll',to:'123@c.us',question:'Quando?',options:['Oggi','Domani']});
 assert.deepEqual(calls.filter(c=>c[0]!=='check')[1],['poll','123@c.us','Quando?',['Oggi','Domani']]);
 setResult(false);await assert.rejects(adapter.send(client,{kind:'document',to:'123@c.us',data:'data',filename:'a.pdf'}),/PROVIDER_REJECTED/);
 for(const result of [true,'','ERROR_FAILURE']){
  setResult(result);await assert.rejects(adapter.send(client,{kind:'document',to:'123@c.us',data:'data',filename:'a.pdf'}),NotSent);
 }
 setResult('true_123@c.us_interactive');
 const content={type:'buttons',body:'Scegli',actions:[{type:'reply',id:'a',label:'Uno'},{type:'reply',id:'b',label:'Due'},{type:'reply',id:'c',label:'Tre'},{type:'reply',id:'d',label:'Quattro'}]};
 assert.equal(await adapter.send(client,{kind:'interactive',to:'123@c.us',content}),'true_123@c.us_interactive');
 assert.deepEqual(calls.at(-1),['interactive','123@c.us',content]);
}));

test('OpenWAUnlocked: logout confermato solo con true e arresto tramite stop',async()=>fixture(async({adapter,stops})=>{
 const client=await adapter.create(sessionId,async()=>{}),root=globalThis as any,previous=root.WAPI;
 try{
  root.WAPI={logout:async()=>true};assert.equal(await client.logout(),true);
  root.WAPI={logout:async()=>false};assert.equal(await client.logout(),false);
  root.WAPI={};await assert.rejects(client.logout(),/LOGOUT_NOT_SUPPORTED/);
 }finally{if(previous===undefined)delete root.WAPI;else root.WAPI=previous;}
 await client.kill();assert.deepEqual(stops,['eulab-stop']);
}));

test('Invio verificato: conta il messaggio visto sul telefono e accettato da WhatsApp, non la risposta della funzione',async()=>fixture(async({adapter,phone,setResult})=>{
 const client=await adapter.create(sessionId,async()=>{});
 const archived:any[]=[];await client.onAnyMessage(m=>archived.push(m));
 // The browser function fails, but the photo left and WhatsApp accepted it: sent, with its real ID.
 setResult(new Error('Cannot read properties of undefined (reading 393331234567@c.us)'));
 assert.match(await adapter.send(client,{kind:'image',to:'393331234567@c.us',data:'data:image/png;base64,AA==',filename:'p.png',caption:''}),/^true_393331234567@c\.us_m\d+$/);
 assert.equal(archived.length,1,'the archive still receives every message');
 // Nothing appeared on the phone: not sent, safe to try again; the reason carries no number.
 phone.appear=false;
 const error=await adapter.send(client,{kind:'image',to:'393331234567@c.us',data:'data:image/png;base64,AA==',filename:'p.png'}).catch(e=>e);
 assert.ok(error instanceof NotSent);assert.doesNotMatch(error.message,/3933/);
 // On the phone but WhatsApp never acknowledged it: unconfirmed, never resent.
 phone.appear=true;phone.ack=null;setResult('true_393331234567@c.us_ok');
 await assert.rejects(adapter.send(client,{kind:'text',to:'393331234567@c.us',text:'Ciao'}),Unconfirmed);
 // WhatsApp error on the message: not delivered, retry allowed.
 phone.ack=-1;setResult('true_393331234567@c.us_err');
 await assert.rejects(adapter.send(client,{kind:'text',to:'393331234567@c.us',text:'Ciao'}),NotSent);
}));

test('Invio verificato: un messaggio uscito verso un altro numero non conferma il nostro',async()=>fixture(async({adapter,phone,setResult})=>{
 const client=await adapter.create(sessionId,async()=>{});
 phone.appear=false;setResult(new Error('boom'));
 const sending=adapter.send(client,{kind:'text',to:'393331234567@c.us',text:'Ciao'});
 setTimeout(()=>phone.onMessage({id:'true_393339999999@c.us_x',fromMe:true,type:'chat',to:'393339999999@c.us',body:'Ciao',ack:1}),5);
 await assert.rejects(sending,NotSent);
}));

test('Motivo del provider senza numeri, ID, link o token',()=>{
 assert.equal(providerReason(new Error('PROVIDER_TIMEOUT')),'PROVIDER_TIMEOUT');
 const reason=providerReason(new Error('Chat 393331234567@c.us not found at https://web.whatsapp.com/x?token=abcdefghijklmnopqrstuvwxyz123456'));
 assert.doesNotMatch(reason,/3933|whatsapp\.com|abcdefghij/);assert.match(reason,/not found/);
});

test('Numero senza WhatsApp: nessun tentativo; il controllo è ricordato per il numero',async()=>fixture(async({adapter,phone,calls})=>{
 const client=await adapter.create(sessionId,async()=>{});
 phone.exists=false;
 await assert.rejects(adapter.send(client,{kind:'text',to:'393330000000@c.us',text:'Ciao'}),NotOnWhatsApp);
 await assert.rejects(adapter.send(client,{kind:'text',to:'393330000000@c.us',text:'Ciao'}),NotOnWhatsApp);
 assert.equal(calls.filter(c=>c[0]==='check').length,1);assert.equal(calls.filter(c=>c[0]==='text').length,0);
 assert.equal(await adapter.ackOf(client,'true_x'),2);
}));

test('Foto a chi non ha ancora una chat: la chat viene aperta prima, senza messaggi in più',async()=>fixture(async({adapter,calls})=>{
 const root=globalThis as any,previous=root.Store,open=new Set<string>();
 root.Store={Chat:{get:(id:string)=>open.has(id)?{id}:undefined,find:async(id:string)=>{calls.push(['find',id]);open.add(id);}}};
 try{
  const client=await adapter.create(sessionId,async()=>{});
  await adapter.send(client,{kind:'image',to:'393331234567@c.us',data:'data:image/png;base64,AA==',filename:'p.png'});
  assert.deepEqual(calls.filter(c=>c[0]!=='check').map(c=>c[0]),['find','file']);
  await adapter.send(client,{kind:'text',to:'393331234567@c.us',text:'Ciao'});
  assert.equal(calls.filter(c=>c[0]==='find').length,1,'text needs no chat, an open chat is not opened again');
  assert.equal((await openChatInPage('393331234567@c.us')).state,'exists');
  root.Store={Chat:{get:()=>undefined,find:async()=>{throw new Error('no');}}};
  assert.equal((await openChatInPage('x@c.us')).state,'missing');
  delete root.Store;assert.equal((await openChatInPage('x@c.us')).state,'unsupported');
 }finally{if(previous===undefined)delete root.Store;else root.Store=previous;}
}));

test('Allegati: URL ricostruito da directPath, chiavi rilette dal telefono se mancano',async()=>{
 const full={id:'false_1@c.us_A',type:'image',mimetype:'image/jpeg',mediaKey:'k',filehash:'h',size:10,directPath:'/v/t62/abc?ccb=1'};
 assert.equal((await mediaSource(full,async()=>null)).deprecatedMms3Url,'https://mmg.whatsapp.net/v/t62/abc?ccb=1');
 // A history record without keys: the phone's copy completes it, the record's own values win.
 const fromPhone=await mediaSource({id:'false_1@c.us_A',type:'image',mimetype:'image/jpeg'},async id=>id==='false_1@c.us_A'?full:null);
 assert.equal(fromPhone.mediaKey,'k');assert.equal(fromPhone.deprecatedMms3Url,'https://mmg.whatsapp.net/v/t62/abc?ccb=1');
 // An explicit URL is kept.
 assert.equal((await mediaSource({...full,clientUrl:'https://mmg.whatsapp.net/x'},async()=>null)).deprecatedMms3Url,undefined);
});

test('Foto: la chat aperta da WhatsApp con ID privato (@lid) riceve la foto',async()=>fixture(async({adapter,calls})=>{
 const root=globalThis as any,previous={store:root.Store,require:root.require};
 root.Store={Chat:{get:()=>undefined}};
 root.require=(name:string)=>name==='WAWebWidFactory'?{createWid:(id:string)=>({_serialized:id})}:name==='WAWebFindChatAction'?{findOrCreateLatestChat:async()=>({chat:{id:{_serialized:'27682913@lid'}}})}:null;
 try{
  const client=await adapter.create(sessionId,async()=>{});
  await adapter.send(client,{kind:'image',to:'393331234567@c.us',data:'data:image/png;base64,AA==',filename:'p.png'});
  assert.equal(calls.find(c=>c[0]==='file')[1],'27682913@lid');
 }finally{root.Store=previous.store;root.require=previous.require;if(previous.store===undefined)delete root.Store;if(previous.require===undefined)delete root.require;}
}));

test('Allegati: decifratura WhatsApp con verifica e rimozione della firma (MAC)',async()=>{
 const {hkdfSync,createCipheriv,createHmac,randomBytes}=await import('node:crypto');
 const mediaKey=randomBytes(32),plain=Buffer.from('foto di prova '.repeat(7));
 const keys=Buffer.from(hkdfSync('sha256',mediaKey,Buffer.alloc(32),'WhatsApp Image Keys',112));
 const iv=keys.subarray(0,16),cipher=createCipheriv('aes-256-cbc',keys.subarray(16,48),iv);
 const body=Buffer.concat([cipher.update(plain),cipher.final()]);
 const mac=createHmac('sha256',keys.subarray(48,80)).update(iv).update(body).digest().subarray(0,10);
 const file=Buffer.concat([body,mac]);
 assert.deepEqual(decryptMediaBytes(file,mediaKey.toString('base64'),'image','image/jpeg'),plain);
 const tampered=Buffer.from(file);tampered[3]^=1;
 assert.throws(()=>decryptMediaBytes(tampered,mediaKey.toString('base64'),'image'),/MEDIA_MAC_MISMATCH/);
});
