import {interactiveContentSchema} from './whatsapp-interactive.js';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
export const uuid = z.string().uuid();
export const key = z.string().regex(/^[a-z][a-z0-9_.:-]{0,79}$/);
export const name = z.string().trim().min(1).max(200);
export const origin = z.string().url().refine(v => { const u = new URL(v); return u.origin === v && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))); }, 'Origine esatta HTTPS richiesta');
export const catalogSchema = z.object({version:z.number().int().positive(),features:z.array(z.object({key,name})).min(1).max(200),permissions:z.array(z.object({key,name,feature:key})).max(1000)}).strict().superRefine((v,ctx) => {
  for (const list of [v.features,v.permissions]) if (new Set(list.map(x=>x.key)).size !== list.length) ctx.addIssue({code:'custom',message:'Chiavi duplicate'});
  if (v.permissions.some(p=>!v.features.some(f=>f.key===p.feature))) ctx.addIssue({code:'custom',message:'Funzione del permesso assente'});
});
export function whatsappRecipient(value:string){
 if(/^(?:\d{5,20}@(c|g)\.us|\d{5,20}@lid)$/.test(value))return value;
 if(!/^\+?[0-9 ()-]+$/.test(value))throw new Error('Numero WhatsApp non valido');
 const digits=value.replace(/\D/g,'').replace(/^00/,'');
 if(!/^[1-9][0-9]{6,14}$/.test(digits))throw new Error('Usa il numero con prefisso internazionale, es. +39 333 1234567');
 return digits+'@c.us';
}
const base = {to:z.string().max(100).transform((v,ctx)=>{try{return whatsappRecipient(v);}catch(e){ctx.addIssue({code:'custom',message:(e as Error).message});return z.NEVER;}})};
export const messageSchema = z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('text'),text:z.string().min(1).max(16000)}).strict(),
 z.object({...base,kind:z.enum(['image','document','audio','video']),data:z.string().max(14_000_000).regex(/^data:(image\/(png|jpeg|webp)|application\/pdf|audio\/(mpeg|ogg|mp4)|video\/mp4);base64,[A-Za-z0-9+/=]+$/),filename:z.string().regex(/^[\w.-]{1,100}$/),caption:z.string().max(2000).default('')}).strict(),
 z.object({...base,kind:z.literal('poll'),question:name,options:z.array(name).min(2).max(12)}).strict(),
 z.object({...base,kind:z.literal('interactive'),content:interactiveContentSchema}).strict()
]).superRefine((message,ctx)=>{
 if(!('data' in message))return;
 const mime=message.data.slice(5,message.data.indexOf(';'));
 const valid=message.kind==='document'?mime==='application/pdf':mime.startsWith(message.kind+'/');
 if(!valid)ctx.addIssue({code:'custom',path:['data'],message:'Il formato del file non corrisponde al tipo di messaggio'});
});
