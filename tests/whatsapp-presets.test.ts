import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileTypeFromBuffer} from 'file-type';
import {botTestModel} from '../apps/web/src/WhatsAppBotLab.js';
import {botDefinitionSchema,botTurn} from '../apps/api/src/whatsapp-bot.js';
import {messageSchema} from '../apps/api/src/validation.js';
test('Modelli admin: allegati reali riconosciuti e compatibili con la validazione di invio',async()=>{
 for(const [kind,filename,mime] of [['image','image.png','image/png'],['document','document.pdf','application/pdf'],['audio','audio.mp3','audio/mpeg'],['video','video.mp4','video/mp4']]){
  const data=await readFile('apps/web/public/whatsapp-test/'+filename);assert.equal((await fileTypeFromBuffer(data))?.mime,mime);
  assert.equal(messageSchema.safeParse({kind,to:'+393331234567',data:`data:${mime};base64,${data.toString('base64')}`,filename}).success,true);
 }
});
test('Modello IVR admin: configurazione valida e percorso di appuntamento completo senza prenotazione fittizia',()=>{
 assert.equal(botDefinitionSchema.safeParse(botTestModel).success,true);
 let result=botTurn(botTestModel,'ciao',null);
 for(const input of ['2','Eugenio','1','Martedì'])result=botTurn(botTestModel,input,result.state);
 assert.equal(result.completed,true);assert.equal(result.outcome,'appointment_requested');assert.match(result.reply!,/non è una prenotazione confermata/);assert.equal(result.answers.name,'Eugenio');assert.equal(result.answers.date,'Martedì');
});
