import {z} from 'zod';
const label=z.string().trim().min(1).max(120),id=z.string().min(1).max(200);
const action=z.discriminatedUnion('type',[
 z.object({type:z.literal('reply'),id,label}).strict(),
 z.object({type:z.literal('url'),label,url:z.string().url().max(2048).refine(v=>new URL(v).protocol==='https:','URL HTTPS richiesto')}).strict(),
 z.object({type:z.literal('call'),label,phoneNumber:z.string().regex(/^\+?[1-9]\d{6,14}$/)}).strict(),
 z.object({type:z.literal('copy'),label,code:z.string().min(1).max(200)}).strict()
]);
const base={body:z.string().trim().min(1).max(4000),footer:z.string().max(500).optional()};
export const interactiveContentSchema=z.discriminatedUnion('type',[
 z.object({...base,type:z.literal('buttons'),header:z.object({type:z.literal('text'),text:label}).strict().optional(),actions:z.array(action).min(1).max(32)}).strict(),
 z.object({...base,type:z.literal('list'),title:label.optional(),buttonLabel:label,sections:z.array(z.object({title:label.optional(),rows:z.array(z.object({id,title:label,description:z.string().max(500).optional()}).strict()).min(1).max(30)}).strict()).min(1).max(10)}).strict()
]).superRefine((content,ctx)=>{
 const ids=content.type==='buttons'?content.actions.filter(a=>a.type==='reply').map(a=>a.id):content.sections.flatMap(s=>s.rows.map(r=>r.id));
 if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'ID interattivi duplicati'});
 if(content.type==='buttons'&&ids.length&&ids.length!==content.actions.length)ctx.addIssue({code:'custom',message:'Le risposte non possono essere mescolate con URL, chiamata o copia'});
});
