// Runs inside Chromium. Rich chat models are not serializable by Puppeteer
// (the unprojected getAllChats() result becomes undefined across the bridge).
// History needs only stable IDs, so transfer those rather than native models.
export async function readChatIds():Promise<{id:string}[]> {
 const chats=await (globalThis as any).WAPI.getAllChats();
 if(!Array.isArray(chats))throw new Error('HISTORY_CHATS_UNAVAILABLE');
 return chats.map(chat=>{
  const id=typeof chat?.id==='string'?chat.id:chat?.id?._serialized;
  if(typeof id!=='string'||!id)throw new Error('HISTORY_CHAT_ID_UNAVAILABLE');
  return {id};
 });
}
