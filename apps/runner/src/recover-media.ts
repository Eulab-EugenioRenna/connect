import type {WaClient} from './openwa.js';
// Read only: recovering a file never sends or replays a WhatsApp message.
export async function recoverMedia(client:WaClient,message:{provider_id:string;chat_id:string}){
 const messages=await client.getAllMessagesInChat(message.chat_id,true,false);
 const original=messages.find(m=>String(m.id)===message.provider_id);
 if(!original)throw new Error('MEDIA_MESSAGE_UNAVAILABLE');
 const data=await client.decryptMedia(original);
 if(typeof data!=='string'||!/^data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+$/.test(data)||data.length>14_000_000)throw new Error('MEDIA_UNAVAILABLE_OR_TOO_LARGE');
 return data;
}
