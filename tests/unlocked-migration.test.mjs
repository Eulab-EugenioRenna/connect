import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('Deploy: migrazione 009 su schema precedente conserva dati e aggiunge contatti, operazioni e IVR',async()=>{
 const db=new PGlite();try{
  for(const name of ['001-connect','002-admin','003-wordpress-users','004-function-sources','005-wordpress-guardian','006-notifications','007-whatsapp-bots','008-whatsapp-realtime'])await db.exec(await readFile('infra/postgres/'+name+'.sql','utf8'));
  await db.query("INSERT INTO identities(subject,display_name,enabled) VALUES('preserved-user','Utente esistente',true)");
  await db.exec(await readFile('infra/postgres/009-whatsapp-unlocked.sql','utf8'));
  assert.equal((await db.query("SELECT display_name FROM identities WHERE subject='preserved-user'")).rows[0].display_name,'Utente esistente');
  for(const table of ['wa_contacts','wa_operations','wa_voice_ivr','wa_voice_turns'])assert.equal((await db.query('SELECT count(*) FROM '+table)).rows[0].count,0);
 }finally{await db.close();}
});
