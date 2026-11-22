import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {OnboardingService} from '../apps/api/src/onboarding.service.js';
import {hash} from '../apps/api/src/security.js';
function setup(){
 const source={id:'source-test',app_id:'test',enabled:true,presenter_id:null};
 const db={query:async(sql:string)=>sql.includes('secret_hash FROM connect_sources')?[{secret_hash:hash('fixture-secret')}]:sql.includes('FROM connect_sources WHERE')?[source]:[]};
 const service=new OnboardingService(db as never,{} as never,{} as never,{} as never);
 const req=(valid=true,ip='127.0.0.9')=>({headers:{'x-connect-source':source.id,authorization:'Bearer '+(valid?'fixture-secret':'invalid')},socket:{remoteAddress:ip}});
 const body={schemaVersion:1,sourceId:source.id,appId:'test'};
 return {service,req,body};
}
const status=(expected:number)=>(e:any)=>e.getStatus?.()===expected;
test('authenticated context checks for different users do not exhaust one shared onboarding/login budget',async()=>{
 const f=setup();
 for(let i=0;i<80;i++){await f.service.authenticate(f.req(),f.body,'one@example.test');await f.service.authenticate(f.req(),f.body,'two@example.test');}
});
test('authenticated context has a separate bounded 600/minute service budget per normalized user',async()=>{
 const f=setup();for(let i=0;i<600;i++)await f.service.authenticate(f.req(),f.body,i%2?'One@Example.Test':'one@example.test');
 await assert.rejects(()=>f.service.authenticate(f.req(),f.body,'one@example.test'),status(429));
 await f.service.authenticate(f.req(),f.body,'another@example.test');
});
test('invalid source credentials retain the shared preauthentication abuse limit',async()=>{
 const f=setup();for(let i=0;i<120;i++)await assert.rejects(()=>f.service.authenticate(f.req(false),f.body,'someone-'+i+'@example.test'),status(401));
 await assert.rejects(()=>f.service.authenticate(f.req(),f.body,'valid@example.test'),status(429));
 await f.service.authenticate(f.req(true,'127.0.0.10'),f.body,'valid@example.test');
});
test('ordinary onboarding operations retain the existing source-wide limit',async()=>{
 const f=setup();for(let i=0;i<120;i++)await f.service.authenticate(f.req(),f.body);
 await assert.rejects(()=>f.service.authenticate(f.req(),f.body),status(429));
});
