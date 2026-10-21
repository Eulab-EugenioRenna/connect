export type InteractiveAction=
 |{type:'reply';id:string;label:string}
 |{type:'url';label:string;url:string}
 |{type:'call';label:string;phoneNumber:string}
 |{type:'copy';label:string;code:string};
/** Portable documents forwarded to OpenWAUnlocked.sendInteractive. */
export type InteractiveContent=
 |{type:'buttons';body:string;footer?:string;header?:{type:'text';text:string};actions:InteractiveAction[]}
 |{type:'list';body:string;footer?:string;title?:string;buttonLabel:string;sections:{title?:string;rows:{id:string;title:string;description?:string}[]}[]};
export interface InteractiveResponse {messageId:string;chatId:string;senderId:string;type:'reply'|'list';id:string;label?:string;timestamp?:number}
export interface CallIdentity {id:string;sessionId:string;generation:string}
export interface CallSnapshot extends CallIdentity {peer:string;state:string;direction:'incoming'|'outgoing';video:boolean;terminal:boolean;observedAt:number}
export interface CallCapabilities {control:boolean;audio:boolean;video:boolean;reason?:{code:string;message:string;status:number}}
export type CallActionResult={ok:true;status:'requested';callId?:string}|{ok:false;status:'unavailable'|'failed'|'unknown';reason:{code:string;message:string;status:number};callId?:string};
export type ProviderCommand=
 |{kind:'contact.refresh';chatId:string}
 |{kind:'call.inspect'}
 |{kind:'call.start';to:string}
 |{kind:'call.accept'|'call.reject'|'call.end';call:CallIdentity}
 |{kind:'call.mute';call:CallIdentity;muted:boolean};
export interface ProviderOperation<T=unknown> {id:string;state:'queued'|'running'|'completed'|'cancelled'|'uncertain';command:ProviderCommand;result:T|null;error:string|null;created_at:string}
export interface ConversationContact {name:string|null;pushName:string|null;description:string|null;avatar:string|null;isBusiness:boolean;isGroup:boolean;updatedAt?:string}
