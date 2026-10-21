import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectBrowser} from '../packages/sdk/src/browser.js';
import {ConnectServer} from '../packages/sdk/src/server.js';
test('SDK browser: ripristino SSO, rinnovo concorrente unico e revoca senza ripetere mutazioni',async()=>{
 const savedFetch=globalThis.fetch,savedStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 const memory=new Map<string,string>();Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)||null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
 const config={apiUrl:'https://connect.test',issuer:'https://sso.test/realms/eulab',clientId:'app',redirectUri:'https://app.test/'};
 memory.set(`connect.session:${config.issuer}:${config.clientId}`,JSON.stringify({refreshToken:'refresh-1'}));
 let refreshes=0,calls=0,revoked=false,expires=1;
 globalThis.fetch=async(input,options={})=>{
  if(String(input).endsWith('/token')){refreshes++;assert(String(options.body).includes('refresh_token'));if(revoked)return Response.json({error:'invalid_grant'},{status:400});return Response.json({access_token:'access-'+refreshes,refresh_token:'refresh-'+refreshes,expires_in:expires});}
  calls++;assert.equal((options.headers as Record<string,string>).Authorization,'Bearer access-'+refreshes);return Response.json({ok:true});
 };
 // callback's no-code branch restores the saved refresh token.
 const previousLocation=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://app.test/'}});
 try{
  const sdk=new ConnectBrowser(config);assert.equal(await sdk.init(),true);assert.equal(refreshes,1);expires=300;
  await Promise.all([sdk.context(),sdk.context(),sdk.context()]);assert.equal(refreshes,2);assert.equal(calls,3);
  revoked=true;await assert.rejects(()=>sdk.refresh(),/scaduta o revocata/);assert.equal(sdk.authenticated,false);assert.equal(memory.size,0);
  await assert.rejects(()=>sdk.request('/v1/test','POST',{value:1}),/Accedi/);assert.equal(calls,3);
 }finally{globalThis.fetch=savedFetch;if(savedStorage)Object.defineProperty(globalThis,'sessionStorage',savedStorage);else Reflect.deleteProperty(globalThis,'sessionStorage');if(previousLocation)Object.defineProperty(globalThis,'location',previousLocation);else Reflect.deleteProperty(globalThis,'location');}
});
test('SDK server: WhatsApp completo nel contesto installazione, numero semplice e idempotenza esplicita',async()=>{
 const original=globalThis.fetch;const requests:{url:string;body:any;headers:Record<string,string>;method:string}[]=[];
 globalThis.fetch=async(input,options={})=>{requests.push({url:String(input),body:options.body?JSON.parse(String(options.body)):null,headers:options.headers as Record<string,string>,method:options.method||'GET'});return Response.json({id:'queued',state:'queued'});};
 try{
  const sdk=new ConnectServer({apiUrl:'https://api.test',installationId:'installation',secret:'server-only'}),wa=sdk.whatsapp('user-access');
  await wa.sendText('session','+39 333 1234567','Test','stable-idem');await wa.conversations('archive');await wa.messages('archive','before','39333@c.us');await wa.deleteConnection('session');
  assert.equal(requests[0].headers['Idempotency-Key'],'stable-idem');assert.equal(requests[0].headers.Authorization,'Bearer user-access');assert.equal(requests[0].headers['X-Installation-Id'],'installation');assert.equal(requests[0].body.to,'+39 333 1234567');
  assert(requests[1].url.endsWith('/archives/archive/conversations'));assert(requests[2].url.includes('chat=39333%40c.us'));assert.equal(requests[3].method,'DELETE');
  for(const kind of ['image','document','audio','video'] as const)await wa.send('session',{kind,to:'+393331234567',data:'data:application/pdf;base64,AAAA',filename:'file.pdf'},'media-'+kind);
  await wa.test('session',{kind:'poll',to:'+393331234567',question:'Scegli',options:['A','B']});await wa.outbox();await wa.media('archive','message');
  assert(requests[8].url.endsWith('/sessions/session/messages/test'));assert.equal(requests[8].body.kind,'poll');assert(requests[9].url.endsWith('/outbox'));assert(requests[10].url.endsWith('/archives/archive/messages/message/media'));
 }finally{globalThis.fetch=original;}
});
test('SDK redirect: PKCE, ritorno interno, callback monouso ed errori correlati allo state',async()=>{
 const keys=['location','history','sessionStorage'] as const,previous=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));const originalFetch=globalThis.fetch;
 const memory=new Map<string,string>(),config={apiUrl:'https://connect.test',issuer:'https://sso.test/realms/eulab',clientId:'app',redirectUri:'https://app.test/callback'};let assigned:URL|undefined,exchanges=0;
 const loc={href:'https://app.test/orders/42',assign:(url:URL)=>{assigned=url;}};
 Object.defineProperty(globalThis,'location',{configurable:true,value:loc});Object.defineProperty(globalThis,'history',{configurable:true,value:{replaceState:(_a:unknown,_b:string,url:string)=>{loc.href=new URL(url,loc.href).href;}}});Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)||null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
 globalThis.fetch=async(_input,options={})=>{exchanges++;assert.equal(new URLSearchParams(String(options.body)).get('redirect_uri'),config.redirectUri);return Response.json({access_token:'validated-by-api',refresh_token:'refresh',expires_in:300});};
 try{
  const sdk=new ConnectBrowser(config);await assert.rejects(()=>sdk.login({returnTo:'https://evil.test'}),/esterna/);await assert.rejects(()=>sdk.login({returnTo:'//evil.test'}),/esterna/);assert.equal(memory.size,0);
  await sdk.login({returnTo:'/orders/42?tab=details',action:'CONFIGURE_TOTP'});assert(assigned);assert.equal(assigned.searchParams.get('kc_action'),'CONFIGURE_TOTP');assert.equal(assigned.searchParams.get('code_challenge_method'),'S256');assert.equal(assigned.searchParams.get('code_challenge')?.length,43);
  const callback=new URL(config.redirectUri);callback.searchParams.set('code','single-use-code');callback.searchParams.set('state',assigned.searchParams.get('state')!);callback.searchParams.set('iss',config.issuer);callback.searchParams.set('kc_action_status','success');loc.href=callback.href;
  const success=await sdk.loginResult();assert.equal(success.status,'authenticated');assert.equal(loc.href,'https://app.test/orders/42?tab=details');assert.equal(exchanges,1);assert.equal(sdk.authenticated,true);
  // A replay cannot exchange the code or keep the previous authenticated state.
  loc.href=callback.href;assert.equal((await sdk.loginResult()).status,'error');assert.equal(exchanges,1);assert.equal(sdk.authenticated,false);assert.equal(loc.href,config.redirectUri);
  await sdk.login();loc.href=config.redirectUri+'?error=access_denied&state=attacker';const invalid=await sdk.loginResult();assert.equal(invalid.status,'error');if(invalid.status==='error')assert.equal(invalid.code,'invalid_state');assert.equal(exchanges,1);
  await sdk.login();loc.href=config.redirectUri+'?error=access_denied&state='+assigned!.searchParams.get('state');const cancelled=await sdk.loginResult();assert.equal(cancelled.status,'error');if(cancelled.status==='error')assert.equal(cancelled.code,'access_denied');assert.equal(exchanges,1);
  await sdk.login();const storageKey=`connect.session:${config.issuer}:${config.clientId}:pkce`,pending=JSON.parse(memory.get(storageKey)!);pending.createdAt=Date.now()-600001;memory.set(storageKey,JSON.stringify(pending));loc.href=config.redirectUri+'?code=expired&state='+pending.state;const expired=await sdk.loginResult();if(expired.status==='error')assert.equal(expired.code,'expired_request');else assert.fail('Expired callback accepted');assert.equal(exchanges,1);
 }finally{globalThis.fetch=originalFetch;for(const key of keys){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
test('Check sessione: refresh a ogni check anche con token fresco, rotazione e deduplica concorrente',async()=>{
 const originalFetch=globalThis.fetch,previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');const memory=new Map<string,string>();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)||null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
 const config={apiUrl:'https://connect.test',issuer:'https://sso.test/realms/eulab',clientId:'app',redirectUri:'https://app.test/'},key=`connect.session:${config.issuer}:${config.clientId}`;
 memory.set(key,JSON.stringify({refreshToken:'refresh-0'}));let refreshes=0,unavailable=false,revoked=false;const used:string[]=[];
 globalThis.fetch=async(input,options={})=>{
  if(String(input).endsWith('/token')){const token=new URLSearchParams(String(options.body)).get('refresh_token')!;used.push(token);if(unavailable)return Response.json({},{status:503});if(revoked)return Response.json({error:'invalid_grant'},{status:400});refreshes++;await Promise.resolve();return Response.json({access_token:'access-'+refreshes,refresh_token:'refresh-'+refreshes,expires_in:300});}
  assert.equal((options.headers as Record<string,string>).Authorization,'Bearer access-'+refreshes);return Response.json({ok:true});
 };
 try{
  const sdk=new ConnectBrowser(config);assert.equal(await sdk.checkSession(),true);assert.equal(refreshes,1);
  assert.equal(await sdk.checkSession(),true);assert.equal(refreshes,2);assert.equal(used[1],'refresh-1');
  await Promise.all([sdk.checkSession(),sdk.checkSession(),sdk.checkSession(),sdk.context()]);assert.equal(refreshes,3);assert.equal(used[2],'refresh-2');assert.equal(JSON.parse(memory.get(key)!).refreshToken,'refresh-3');
  unavailable=true;await assert.rejects(()=>sdk.checkSession(),/temporaneamente/);assert.equal(JSON.parse(memory.get(key)!).refreshToken,'refresh-3');unavailable=false;
  assert.equal(await sdk.checkSession(),true);assert.equal(refreshes,4);assert.equal(used.at(-1),'refresh-3');
  revoked=true;assert.equal(await sdk.checkSession(),false);assert.equal(sdk.authenticated,false);assert.equal(memory.size,0);const count=used.length;assert.equal(await sdk.checkSession(),false);assert.equal(used.length,count);
 }finally{globalThis.fetch=originalFetch;if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else Reflect.deleteProperty(globalThis,'sessionStorage');}
});
test('Refresh in ritardo dopo logout non ripristina token o sessione',async()=>{
 const originalFetch=globalThis.fetch,storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),location=Object.getOwnPropertyDescriptor(globalThis,'location');const memory=new Map<string,string>();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)||null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});Object.defineProperty(globalThis,'location',{configurable:true,value:{assign:()=>{}}});
 const config={apiUrl:'https://connect.test',issuer:'https://sso.test/realms/eulab',clientId:'app',redirectUri:'https://app.test/'};memory.set(`connect.session:${config.issuer}:${config.clientId}`,JSON.stringify({refreshToken:'old-refresh'}));
 let resolve!:(r:Response)=>void;globalThis.fetch=()=>new Promise<Response>(r=>{resolve=r;});
 try{const sdk=new ConnectBrowser(config),check=sdk.checkSession();sdk.logout();resolve(Response.json({access_token:'late-access',refresh_token:'late-refresh',expires_in:300}));assert.equal(await check,false);assert.equal(sdk.authenticated,false);assert.equal(memory.size,0);}
 finally{globalThis.fetch=originalFetch;for(const [key,descriptor] of [['sessionStorage',storage],['location',location]] as const){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
test('SDK come service condiviso: init concorrenti consumano il callback una sola volta',async()=>{
 const keys=['location','history','sessionStorage'] as const,previous=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)])),originalFetch=globalThis.fetch;
 const memory=new Map<string,string>(),config={apiUrl:'https://connect.test',issuer:'https://sso.test/realms/eulab',clientId:'app',redirectUri:'https://app.test/callback'};let redirect!:URL,calls=0;
 const loc={href:'https://app.test/',assign:(url:URL)=>{redirect=url;}};
 Object.defineProperty(globalThis,'location',{configurable:true,value:loc});Object.defineProperty(globalThis,'history',{configurable:true,value:{replaceState:(_a:unknown,_b:string,url:string)=>{loc.href=url;}}});Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)||null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
 globalThis.fetch=async()=>{calls++;await Promise.resolve();return Response.json({access_token:'access-'+calls,refresh_token:'refresh-'+calls,expires_in:300});};
 try{
  const service=new ConnectBrowser(config);await service.login();loc.href=config.redirectUri+'?code=code&state='+redirect.searchParams.get('state');
  const results=await Promise.all([service.init(),service.init(),service.callback()]);assert.deepEqual(results,[true,true,true]);assert.equal(calls,1);assert.equal(service.authenticated,true);
  assert.equal(await service.checkSession(),true);assert.equal(calls,2);
 }finally{globalThis.fetch=originalFetch;for(const key of keys){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
test('SDK bot: la definizione dell’app viene trasportata senza modelli o domande preimpostate',async()=>{
 const original=globalThis.fetch;const calls:{path:string;method:string;body:any;headers:Record<string,string>}[]=[];
 globalThis.fetch=async(input,options={})=>{calls.push({path:String(input),method:options.method||'GET',body:options.body?JSON.parse(String(options.body)):null,headers:options.headers as Record<string,string>});return Response.json({});};
 try{
  const sdk=new ConnectServer({apiUrl:'https://api.test',installationId:'app-installation',secret:'server-only'}),bot=sdk.whatsapp('customer-token').bot;
  const definition={name:'Scelto dal cliente',trigger:'PAROLA CLIENTE',startNodeId:'custom',sessionTimeoutMinutes:20,invalidReply:'Risposta errata',nodes:[{id:'custom',type:'end' as const,text:'Testo scelto dal cliente'}]};
  await bot.get('number-archive');await bot.configure('number-archive',definition,3);await bot.activate('number-archive',true,4);await bot.preview(definition,'PAROLA CLIENTE');
  assert(calls[0].path.endsWith('/archives/number-archive/bot'));assert.equal(calls[1].method,'PUT');assert.deepEqual(calls[1].body,{definition,expectedRevision:3});assert.deepEqual(calls[2].body,{enabled:true,expectedRevision:4});assert(calls[3].path.endsWith('/bot/preview'));assert.equal(calls[3].body.state,null);assert(calls.every(c=>c.headers.Authorization==='Bearer customer-token'));
 }finally{globalThis.fetch=original;}
});
