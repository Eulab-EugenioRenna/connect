// Synthetic process used only by automation-process.test.mjs; no WhatsApp client is loaded.
import {Database} from '../dist/server/apps/api/src/database.js';
import {runOutbox} from '../dist/server/apps/runner/src/outbox.js';
const db=new Database();
const [outbox]=await db.query('SELECT actor FROM outbox WHERE id=$1',[process.env.SYNTHETIC_OUTBOX_ID]);
globalThis.fetch=async(input,options)=>{
 const url=String(input);
 if(url===process.env.OIDC_INTERNAL_ISSUER+'/protocol/openid-connect/token')return Response.json({access_token:'synthetic-child-service-token',expires_in:300});
 if(url===process.env.OIDC_INTERNAL_ISSUER.replace('/realms/','/admin/realms/')+'/users/'+encodeURIComponent(outbox.actor))return Response.json({id:outbox.actor,enabled:true});
 throw new Error('Synthetic worker forbids all other HTTP');
};
await runOutbox(db,process.env.SYNTHETIC_OUTBOX_ID,'synthetic-runner',async()=>async()=>{
 if(process.env.SYNTHETIC_CRASH_STAGE==='before'){process.send({stage:'before'});await new Promise(()=>{});}
 await db.query('INSERT INTO synthetic_provider_effects(outbox_id) VALUES($1)',[process.env.SYNTHETIC_OUTBOX_ID]);
 process.send({stage:'after'});await new Promise(()=>{});return 'unreachable';
});
