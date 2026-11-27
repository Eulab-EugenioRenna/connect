/**
 * Runs inside WhatsApp Web (puppeteer evaluate): only its own source travels to the page.
 * No named inner functions or imports: the runtime build (esbuild keepNames) wraps them
 * in __name(), which does not exist in the page and made every chat opening fail.
 */
export async function openChatInPage(to:string):Promise<{state:'exists'|'opened'|'missing'|'unsupported';chatId:string|null;via:string}>{
 const root=globalThis as any,chats=root.Store?.Chat;
 if(chats&&typeof chats.get==='function'){
  const found=chats.get(to);
  if(found)return {state:'exists',chatId:typeof found.id==='string'?found.id:typeof found.id?._serialized==='string'?found.id._serialized:to,via:'store'};
 }
 let widFactory:any=null,finder:any=null;
 if(typeof root.require==='function'){
  try{widFactory=root.require('WAWebWidFactory');}catch{widFactory=null;}
  try{finder=root.require('WAWebFindChatAction');}catch{finder=null;}
 }
 if(widFactory?.createWid&&finder?.findOrCreateLatestChat){
  try{
   const result=await finder.findOrCreateLatestChat(widFactory.createWid(to)),chat=result?.chat??result;
   const chatId=typeof chat?.id==='string'?chat.id:typeof chat?.id?._serialized==='string'?chat.id._serialized:null;
   if(chatId)return {state:'opened',chatId,via:'findOrCreateLatestChat'};
  }catch{ /* older WhatsApp Web: try the Store below */ }
 }
 if(chats&&typeof chats.find==='function'){
  try{
   const chat=(await chats.find(to))??chats.get(to);
   const chatId=typeof chat?.id==='string'?chat.id:typeof chat?.id?._serialized==='string'?chat.id._serialized:null;
   if(chatId)return {state:'opened',chatId,via:'store.find'};
  }catch{ /* below */ }
  return {state:'missing',chatId:null,via:'store.find'};
 }
 return {state:chats?'missing':'unsupported',chatId:null,via:'none'};
}
