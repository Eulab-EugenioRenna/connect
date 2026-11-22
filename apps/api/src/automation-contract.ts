import {z} from 'zod';
import {uuid,key,messageSchema} from './validation.js';
import {hash} from './security.js';
export const idempotencyKeySchema=z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const delegationSchema=z.object({
 purpose:z.string().min(1).max(120).regex(/^[a-z][a-z0-9_.:-]*$/),
 channel:z.enum(['whatsapp','application_notification','email']),
 functions:z.array(key).min(1).max(32).transform(v=>[...new Set(v)].sort()),
 archiveId:uuid.optional(),expiresAt:z.string().datetime({offset:true})
}).strict().superRefine((v,ctx)=>{
 const wa=v.channel==='whatsapp';
 if(wa?(!v.archiveId||v.functions.join(',')!=='whatsapp.manage,whatsapp.send'):(!!v.archiveId||v.functions.some(f=>f.startsWith('whatsapp.'))))ctx.addIssue({code:'custom',message:'Ambito canale non valido'});
});
export const verificationSchema=z.object({purpose:z.string().min(1).max(120),channel:z.enum(['whatsapp','application_notification','email']),functions:z.array(key).min(1).max(32)}).strict();
export const delegatedMessageSchema=z.object({purpose:z.string().min(1).max(120),sessionId:uuid,payload:messageSchema}).strict();
/** Canonical object ordering: retries with reordered JSON fields have the same receipt. */
export function requestHash(value:unknown):string{
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return hash(JSON.stringify(canonical(value)));
}
export type DelegationInput=z.infer<typeof delegationSchema>;
