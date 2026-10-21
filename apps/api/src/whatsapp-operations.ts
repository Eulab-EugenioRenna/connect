import {z} from 'zod';
import {whatsappRecipient} from './validation.js';
const recipient=z.string().max(100).transform((v,ctx)=>{try{return whatsappRecipient(v);}catch{ctx.addIssue({code:'custom',message:'Destinatario non valido'});return z.NEVER;}});
const call=z.object({id:z.string().min(1).max(300),sessionId:z.string().min(1).max(100),generation:z.string().min(1).max(200)}).strict();
export const providerCommandSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('contact.refresh'),chatId:recipient}).strict(),
 z.object({kind:z.literal('call.inspect')}).strict(),
 z.object({kind:z.literal('call.start'),to:recipient}).strict(),
 z.object({kind:z.literal('call.accept'),call}).strict(),
 z.object({kind:z.literal('call.reject'),call}).strict(),
 z.object({kind:z.literal('call.end'),call}).strict(),
 z.object({kind:z.literal('call.mute'),call,muted:z.boolean()}).strict()
]);
export function operationPermission(kind:string){return kind==='contact.refresh'||kind==='call.inspect'?'whatsapp.read':'whatsapp.manage';}
