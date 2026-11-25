import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OpenWaAdapter} from '../apps/runner/src/openwa.js';

const sessionId='00000000-0000-0000-0000-000000000001';
async function fixture(run:(context:any)=>Promise<void>){
 const directory=await mkdtemp(path.join(tmpdir(),'connect-unlocked-'));
 const previous={profile:process.env.OPENWA_PROFILE_DIR,key:process.env.DATA_ENCRYPTION_KEY};
 process.env.OPENWA_PROFILE_DIR=directory;process.env.DATA_ENCRYPTION_KEY='ab'.repeat(32);
 const events=new EventEmitter(),stops:string[]=[],calls:any[]=[];
 let config:any,startError:Error|undefined,result:unknown='true_123@c.us_message';
 class Driver {}
 class Client {
  constructor(options:any){assert.equal(options.transport,'transport');}
  async start(){
   if(config.linkCode)events.emit('launch.auth.linkCode.generated',{details:{linkCode:'ab12cd34'}});
   else events.emit('launch.auth.qr.generated',{details:{qr:'fixture-qr'}});
   if(startError)throw startError;
  }
  async stop(reason:string){stops.push(reason);}
  async sendInteractive(...args:any[]){calls.push(['interactive',...args]);return result;}
  async sendText(...args:any[]){calls.push(['text',...args]);return result;}
  async sendFile(...args:any[]){calls.push(['file',...args]);return result;}
  async sendPoll(...args:any[]){calls.push(['poll',...args]);return result;}
  async evaluate(fn:any,arg:any){return fn(arg);}
 }
 class Adapter extends OpenWaAdapter {
  protected async loadProvider(){return [
   {createClient:async(options:any)=>{config=options;return {events,getTransport:()=> 'transport'};}},
   {Client},{PuppeteerDriver:Driver},{default:{toDataURL:async(value:string)=>'data:image/png;base64,'+value}}
  ];}
 }
 const adapter=new Adapter();
 try{await run({adapter,directory,events,stops,calls,config:()=>config,setError:(error:Error)=>{startError=error;},setResult:(value:unknown)=>{result=value;},Driver});}
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
 assert.equal(peak,1);assert.equal(calls.length,4);
}));

test('OpenWAUnlocked: media e sondaggi conservano parametri e ID, true resta non confermato, false è un rifiuto',async()=>fixture(async({adapter,calls,setResult})=>{
 const client=await adapter.create(sessionId,async()=>{});
 const id=await adapter.send(client,{kind:'image',to:'123@c.us',data:'data:image/png;base64,AA==',filename:'photo.png',caption:'Foto'});
 assert.equal(id,'true_123@c.us_message');
 assert.deepEqual(calls[0],['file','123@c.us','data:image/png;base64,AA==','photo.png',{caption:'Foto'}]);
 await adapter.send(client,{kind:'poll',to:'123@c.us',question:'Quando?',options:['Oggi','Domani']});
 assert.deepEqual(calls[1],['poll','123@c.us','Quando?',['Oggi','Domani']]);
 setResult(false);await assert.rejects(adapter.send(client,{kind:'document',to:'123@c.us',data:'data',filename:'a.pdf'}),/PROVIDER_REJECTED/);
 for(const result of [true,'','ERROR_FAILURE']){
  setResult(result);await assert.rejects(adapter.send(client,{kind:'document',to:'123@c.us',data:'data',filename:'a.pdf'}),/PROVIDER_RESULT_UNCONFIRMED/);
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
