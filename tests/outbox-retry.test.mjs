import test from 'node:test';
import assert from 'node:assert/strict';
import {automationFixture} from './automation-fixture.mjs';
import {runOutbox,outboxRetry,reconcileOutbox} from '../dist/server/apps/runner/src/outbox.js';
import {NotSent,Unconfirmed,NotOnWhatsApp} from '../dist/server/apps/runner/src/openwa.js';
const ok=r=>{assert(r.status>=200&&r.status<300,JSON.stringify(r));return r.body;};
const row=(h,id)=>h.q('SELECT state,attempts,not_before,error FROM outbox WHERE id=$1',[id]).then(rows=>rows[0]);
const due=(h,id)=>h.q("UPDATE outbox SET not_before=now()-interval '1 second' WHERE id=$1",[id]);

test('Outbox: non partito (verificato sul telefono) si riprova da solo, poi fallisce; mai doppioni',async()=>{
 const h=await automationFixture();try{
  const {id}=ok(await h.send(h.message,'retry-verified-001'));let effects=0;
  const notSent=async()=>async()=>{effects++;throw new NotSent('NOT_ON_PHONE');};
  await runOutbox(h.store,id,'synthetic-runner',notSent);
  let r=await row(h,id);assert.equal(r.state,'queued');assert.equal(r.attempts,1);assert.ok(new Date(r.not_before)>new Date());assert.match(r.error,/^retrying: tentativo 1 di 6 non partito \(NOT_ON_PHONE\), nuovo tentativo tra 20 secondi/);
  // Not before the pause.
  await runOutbox(h.store,id,'synthetic-runner',notSent);assert.equal(effects,1);
  for(let n=2;n<=outboxRetry.attempts;n++){await due(h,id);await runOutbox(h.store,id,'synthetic-runner',notSent);}
  r=await row(h,id);assert.equal(effects,6);assert.equal(r.state,'failed');assert.match(r.error,/^not_sent: non partito dopo 6 tentativi \(NOT_ON_PHONE\)/);
  // A retry that succeeds ends as sent.
  const second=ok(await h.send(h.message,'retry-verified-002'));
  await runOutbox(h.store,second.id,'synthetic-runner',notSent);await due(h,second.id);
  await runOutbox(h.store,second.id,'synthetic-runner',async()=>async()=>'true_x@c.us_ok');
  assert.equal((await row(h,second.id)).state,'sent');
  // On the phone without acknowledgement: uncertain, never resent.
  const third=ok(await h.send(h.message,'retry-verified-003'));
  await runOutbox(h.store,third.id,'synthetic-runner',async()=>async()=>{throw new Unconfirmed('WHATSAPP_NO_ACK','true_x@c.us_late');});
  r=await row(h,third.id);assert.equal(r.state,'uncertain');assert.match(r.error,/WHATSAPP_NO_ACK/);
  // Checked again by ID: still waiting stays; acknowledged later becomes sent with its event.
  await reconcileOutbox(h.store,'synthetic-runner',async()=>0);assert.equal((await row(h,third.id)).state,'uncertain');
  await reconcileOutbox(h.store,'synthetic-runner',async(_s,id)=>id==='true_x@c.us_late'?2:null);
  assert.equal((await row(h,third.id)).state,'sent');
  assert.equal((await h.q("SELECT count(*)::int n FROM events WHERE kind='message.sent' AND payload->>'outboxId'=$1",[third.id]))[0].n,1);
  // Error on the message: verified not sent, tried again.
  const fourth=ok(await h.send(h.message,'retry-verified-004'));
  await runOutbox(h.store,fourth.id,'synthetic-runner',async()=>async()=>{throw new Unconfirmed('WHATSAPP_NO_ACK','true_x@c.us_bad');});
  await reconcileOutbox(h.store,'synthetic-runner',async()=>-1);
  r=await row(h,fourth.id);assert.equal(r.state,'queued');assert.equal(r.attempts,1);
  // No WhatsApp account: failed at once, no retries.
  const fifth=ok(await h.send(h.message,'retry-verified-005'));
  await runOutbox(h.store,fifth.id,'synthetic-runner',async()=>async()=>{throw new NotOnWhatsApp('NOT_ON_WHATSAPP');});
  r=await row(h,fifth.id);assert.equal(r.state,'failed');assert.equal(r.error,'not_on_whatsapp');
 }finally{await h.close();}
});

test('Outbox: annulla il singolo messaggio in attesa (anche tra un tentativo e l’altro), non quello già partito',async()=>{
 const h=await automationFixture();try{
  const cancel=id=>h.request(`/v1/installations/${h.installation}/whatsapp/outbox/${id}/cancel`,'POST',{},h.personal);
  const {id}=ok(await h.send(h.message,'cancel-single-001'));
  await runOutbox(h.store,id,'synthetic-runner',async()=>async()=>{throw new NotSent('NOT_ON_PHONE');});
  const r=await cancel(id);assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.body.state,'cancelled');assert.equal(r.body.attempts,1);
  let effects=0;await due(h,id);await runOutbox(h.store,id,'synthetic-runner',async()=>async()=>{effects++;return 'x';});assert.equal(effects,0);
  const sent=ok(await h.send(h.message,'cancel-single-002'));
  await runOutbox(h.store,sent.id,'synthetic-runner',async()=>async()=>'true_x@c.us_ok');
  assert.equal((await cancel(sent.id)).body.state,'sent');
 }finally{await h.close();}
});
