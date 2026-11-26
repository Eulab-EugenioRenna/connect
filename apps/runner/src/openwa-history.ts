// Runs inside Chromium. Rich chat models are not serializable by Puppeteer
// (the unprojected getAllChats() result becomes undefined across the bridge).
// History needs only stable IDs, so transfer those rather than native models.
export async function readChatIds():Promise<{id:string;t:number|null}[]> {
 const chats=await (globalThis as any).WAPI.getAllChats();
 if(!Array.isArray(chats))throw new Error('HISTORY_CHATS_UNAVAILABLE');
 return chats.map(chat=>{
  const id=typeof chat?.id==='string'?chat.id:chat?.id?._serialized;
  if(typeof id!=='string'||!id)throw new Error('HISTORY_CHAT_ID_UNAVAILABLE');
  // Time of the last message: an update skips chats with nothing new.
  return {id,t:typeof chat?.t==='number'&&Number.isFinite(chat.t)?chat.t:null};
 });
}
