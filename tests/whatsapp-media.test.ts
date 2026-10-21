import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverMedia} from '../apps/runner/src/recover-media.js';
import type {WaClient} from '../apps/runner/src/openwa.js';
test('Recupero allegato: usa il messaggio originale e non invia nulla',async()=>{
 let decrypted:unknown;const original={id:'provider-id',mimetype:'image/png'};
 const client={getAllMessagesInChat:async(chat:string,me:boolean,notifications:boolean)=>{assert.equal(chat,'chat');assert.equal(me,true);assert.equal(notifications,false);return [original];},decryptMedia:async(m:unknown)=>{decrypted=m;return 'data:image/png;base64,AAAA';}} as WaClient;
 assert.equal(await recoverMedia(client,{provider_id:'provider-id',chat_id:'chat'}),'data:image/png;base64,AAAA');assert.equal(decrypted,original);
 await assert.rejects(()=>recoverMedia(client,{provider_id:'missing',chat_id:'chat'}),/MEDIA_MESSAGE_UNAVAILABLE/);
 client.decryptMedia=async()=> 'https://example.com/file';await assert.rejects(()=>recoverMedia(client,{provider_id:'provider-id',chat_id:'chat'}),/MEDIA_UNAVAILABLE/);
});
