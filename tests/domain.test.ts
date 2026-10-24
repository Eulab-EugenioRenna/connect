import test from 'node:test';
import assert from 'node:assert/strict';
import {decision,PolicyFacts} from '../apps/api/src/policy.js';
import {seal,unseal,sealMigrationValue,unsealMigrationValue,signature,verifySignature} from '../apps/api/src/security.js';
import {verifyWebhook} from '../packages/sdk/src/server.js';
import {publicAddress} from '../apps/runner/src/webhooks.js';
import {catalogSchema,messageSchema} from '../apps/api/src/validation.js';
const valid:PolicyFacts={installationEnabled:true,identityEnabled:true,memberEnabled:true,linked:true,accessRevoked:false,licenseState:'active',expiresAt:null,purchased:true,featureEnabled:true,catalogActive:true,permissionGranted:true};
test('Autorizzazione: tutti i requisiti sono necessari e le revoche prevalgono',()=>{
 assert.equal(decision(valid).allowed,true);
 for(const key of ['installationEnabled','identityEnabled','memberEnabled','linked','accessRevoked','purchased','featureEnabled','catalogActive','permissionGranted'])assert.equal(decision({...valid,[key]:key==='accessRevoked'?true:false}).allowed,false,key);
 assert.equal(decision({...valid,accessRevoked:true}).reason,'access_revoked');
 assert.equal(decision({...valid,licenseState:'suspended'}).allowed,false);
 assert.equal(decision({...valid,expiresAt:new Date(0)}).reason,'license_expired');
});
test('Cataloghi: chiavi duplicate e permessi senza funzione sono rifiutati',()=>{
 assert.equal(catalogSchema.safeParse({version:1,features:[{key:'wa',name:'WhatsApp'}],permissions:[{key:'wa.send',name:'Invio',feature:'other'}]}).success,false);
 assert.equal(catalogSchema.safeParse({version:1,features:[{key:'wa',name:'A'},{key:'wa',name:'B'}],permissions:[]}).success,false);
});
test('Media: URL remoti, percorsi e payload non supportati non raggiungono OpenWA',()=>{
 assert.equal(messageSchema.safeParse({kind:'document',to:'393331234567@c.us',data:'http://127.0.0.1/secrets',filename:'../../file'}).success,false);
 assert.equal(messageSchema.safeParse({kind:'text',to:'393331234567@c.us',text:'Prova'}).success,true);
});
test('Webhook: firma su corpo originale, finestra temporale e alterazioni',()=>{
 const t=String(Math.floor(Date.now()/1000)),body='{"id":"event-1"}',sig=signature('test-key',t,body);
 assert(verifySignature('test-key',t,body,sig));assert(verifyWebhook('test-key',body,t,sig));
 assert.equal(verifySignature('test-key',t,body+' ',sig),false);assert.equal(verifySignature('test-key','0',body,sig),false);
});
test('Webhook: indirizzi privati e locali sono bloccati',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.2','192.168.1.2','169.254.169.254','100.64.0.1','::1','0.0.0.0'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);
});
test('Segreti: cifratura autenticata e chiavi errate',()=>{
 process.env.DATA_ENCRYPTION_KEY='a'.repeat(64);const cipher=seal('riservato');assert(!cipher.includes('riservato'));assert.equal(unseal(cipher),'riservato');
 process.env.DATA_ENCRYPTION_KEY='b'.repeat(64);assert.throws(()=>unseal(cipher));process.env.DATA_ENCRYPTION_KEY='a'.repeat(64);
 const legacy=seal('compatibile');process.env.DATA_ENCRYPTION_KEY='a'.repeat(64);assert.equal(unseal(legacy),'compatibile');
 process.env.MIGRATION_ENCRYPTION_KEY='c'.repeat(64);const migration=sealMigrationValue('transitoria','request-1');
 assert.equal(unsealMigrationValue(migration,'request-1'),'transitoria');assert.throws(()=>unsealMigrationValue(migration,'request-2'));
 process.env.MIGRATION_ENCRYPTION_KEY='corta';assert.throws(()=>sealMigrationValue('transitoria','request-1'));process.env.MIGRATION_ENCRYPTION_KEY='c'.repeat(64);
});

test('Media WhatsApp: il MIME deve corrispondere al tipo scelto',()=>{
 assert.equal(messageSchema.safeParse({kind:'image',to:'+393331234567',data:'data:application/pdf;base64,AAAA',filename:'file.pdf'}).success,false);
 assert.equal(messageSchema.safeParse({kind:'document',to:'+393331234567',data:'data:application/pdf;base64,AAAA',filename:'file.pdf'}).success,true);
});
