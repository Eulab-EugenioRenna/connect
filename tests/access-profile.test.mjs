import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';

const LOCAL_USER='f5e1f8aa-5055-477c-ae54-a01a8fe9ac15';

test('Profilo locale su installazioni web: elenco admin, ticket vincolato e ricontrollo al riscatto',async()=>{
 const h=await harness();try{
  const customer=(await h.request('/v1/customers','POST',{name:'ALORA Test'})).body;
  const connected=(await h.request('/v1/application-connections','POST',{name:'ALORA Test',customerId:customer.id,domain:'https://alora.example',integration:'web'})).body;
  const installationId=connected.installationId,appId=connected.appId;
  const serverHeaders={'X-Installation-Id':installationId,'X-Installation-Secret':connected.secret,Authorization:''};

  assert.equal((await h.request('/v1/identities','PUT',{subject:'profile-subject',displayName:'Demo Owner',enabled:true})).status,200);
  assert.equal((await h.request('/v1/memberships','PUT',{subject:'profile-subject',customerId:customer.id,enabled:true,roleIds:[]})).status,200);
  assert.equal((await h.request('/v1/identity-links','PUT',{installationId,localUserId:LOCAL_USER,subject:'profile-subject'})).status,200);

  const list=await h.request(`/v1/installations/${installationId}/access-users`);
  assert.equal(list.status,200);
  assert.equal(list.body.total,1);
  assert.equal(list.body.installation.customerName,'ALORA Test');
  assert.equal(list.body.installation.appName,'ALORA Test');
  assert.equal(list.body.items[0].localUserId,LOCAL_USER);
  assert.equal(list.body.items[0].displayName,'Demo Owner');
  assert.deepEqual(list.body.items[0].roles,[]);
  assert.equal((await h.request(`/v1/installations/${installationId}/access-users?search=owner`)).body.total,1);
  assert.equal((await h.request(`/v1/installations/${installationId}/access-users?search=nessuno`)).body.total,0);

  const technicianToken=await h.token('technician',['eulab-technician']);
  assert.equal((await h.request(`/v1/installations/${installationId}/access-users`,'GET',undefined,{Authorization:`Bearer ${technicianToken}`})).status,403);
  assert.equal((await h.request('/v1/technical/tickets','POST',{installationId,localUserId:LOCAL_USER},{Authorization:`Bearer ${technicianToken}`})).status,403);

  const selected=await h.request('/v1/technical/tickets','POST',{installationId,localUserId:LOCAL_USER});
  assert.equal(selected.status,201);
  assert.equal(selected.body.localUserId,LOCAL_USER);
  assert.equal(selected.body.technicalUrl,`https://alora.example/eulab/connect/technical?installation=${installationId}`);
  const redeemed=await h.request('/v1/technical/redeem','POST',{ticket:selected.body.ticket},serverHeaders);
  assert.equal(redeemed.status,201);
  assert.equal(redeemed.body.scope,'eulab-access-as');
  assert.equal(redeemed.body.localUserId,LOCAL_USER);
  assert.equal(redeemed.body.localSubject,'profile-subject');
  assert.equal(redeemed.body.subject,'operator');
  assert.equal((await h.request('/v1/technical/redeem','POST',{ticket:selected.body.ticket},serverHeaders)).status,401);

  const pending=await h.request('/v1/technical/tickets','POST',{installationId,localUserId:LOCAL_USER});
  assert.equal(pending.status,201);
  assert.equal((await h.request(`/v1/identity-links/${installationId}/${LOCAL_USER}`,'DELETE')).status,200);
  assert.equal((await h.request('/v1/technical/redeem','POST',{ticket:pending.body.ticket},serverHeaders)).status,401);
  assert.equal((await h.request('/v1/technical/tickets','POST',{installationId,localUserId:LOCAL_USER})).status,403);

  await h.request('/v1/identity-links','PUT',{installationId,localUserId:LOCAL_USER,subject:'profile-subject'});
  await h.store.query('INSERT INTO app_access_revocations(customer_id,app_id,subject,revoked_by) VALUES($1,$2,$3,$4)',[customer.id,appId,'profile-subject','qa']);
  assert.equal((await h.request('/v1/technical/tickets','POST',{installationId,localUserId:LOCAL_USER})).status,403);
  assert.equal((await h.request(`/v1/installations/${installationId}/access-users`)).body.total,0);
  await h.store.query('DELETE FROM app_access_revocations WHERE customer_id=$1 AND app_id=$2 AND subject=$3',[customer.id,appId,'profile-subject']);
  assert.equal((await h.request(`/v1/installations/${installationId}/access-users`)).body.total,1);

  const technical=await h.request('/v1/technical/tickets','POST',{installationId},{Authorization:`Bearer ${technicianToken}`});
  assert.equal(technical.status,201);
  assert.equal(technical.body.localUserId,null);
  const technicalRedeemed=await h.request('/v1/technical/redeem','POST',{ticket:technical.body.ticket},serverHeaders);
  assert.equal(technicalRedeemed.status,201);
  assert.equal(technicalRedeemed.body.scope,'eulab-technical');
  assert.equal(technicalRedeemed.body.localUserId,null);

  const wordpress=(await h.request('/v1/application-connections','POST',{name:'Sito Test',customerId:customer.id,domain:'https://wp.example',integration:'wordpress'})).body;
  assert.equal((await h.request(`/v1/installations/${wordpress.installationId}/access-users`)).status,400);

  const audit=(await h.store.query("SELECT detail FROM audit WHERE action='technical.ticket.issue' AND detail->>'localUserId'=$1",[LOCAL_USER]))[0];
  assert.equal(audit.detail.localUsername,'Demo Owner');
 }finally{await h.close();}
});
