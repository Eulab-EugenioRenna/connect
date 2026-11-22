import type {WhatsAppPayload,Request} from './whatsapp.js';
export type AutomationChannel='whatsapp'|'application_notification'|'email';
export interface AutomationDelegationInput {purpose:string;channel:AutomationChannel;functions:string[];archiveId?:string;expiresAt:string}
export interface AutomationDelegation {id:string;installationId:string;appId:string;actor:string;purpose:string;channel:AutomationChannel;functions:string[];archiveId:string|null;revision:number;expiresAt:string;revokedAt:string|null;createdAt:string}
/** Secret-bearing result: persist encrypted on the consumer server, never project to the UI. */
export interface AutomationGrant {delegation:AutomationDelegation;credential:string}
export interface AutomationScope {purpose:string;channel:AutomationChannel;functions:string[]}
export interface AutomationVerification {allowed:boolean;reason:string}
export interface DelegatedMessageInput {purpose:string;sessionId:string;payload:WhatsAppPayload}
export interface DelegatedMessageStatus {id:string;sessionId:string;state:'queued'|'sending'|'sent'|'failed'|'uncertain'|'cancelled';providerId:string|null;error:string|null;createdAt:string}
/** Withdrawal never implies cancellation of an effect that the runner has already acquired. */
export type DelegatedMessageWithdrawal=
 |{outcome:'withdrawn';message:DelegatedMessageStatus&{state:'cancelled'}}
 |{outcome:'already_terminal';message:DelegatedMessageStatus&{state:'cancelled'|'failed'}}
 |{outcome:'effect_started';message:DelegatedMessageStatus&{state:'sending'|'sent'|'uncertain'}};
export interface WebhookRegistration {id:string;url:string;enabled:boolean;secret:string}
/** Signed original-body webhook envelope. Signature verification does not replace durable event-ID deduplication. */
export interface ConnectWebhookEvent<T=unknown> {id:string;installationId:string;sessionId:string;kind:string;createdAt:string;payload:T}
export interface WhatsAppMessageEventPayload {
 messageId:string;providerId:string;sessionId:string;messageSessionId:string;archiveId:string;
 chatId:string;direction:'in'|'out'|'unknown';fromMe:boolean|null;senderId:string|null;recipientId:string|null;
 occurredAt:string;observedAt:string;timestampSource:'provider'|'connect'|'unknown';source:'whatsapp_provider';addressingVerified:boolean;
 kind:string;body:{text:string;selectedButtonId:string|null;[key:string]:unknown};
}
export function automationClient(request:Request,installationId:string){
 const root=`/v1/installations/${encodeURIComponent(installationId)}/automations`,delegation=(id:string)=>root+'/delegations/'+encodeURIComponent(id),headers=(credential?:string):Record<string,string>=>credential?{'X-Connect-Delegation':credential}:{};
 return {
  create:(input:AutomationDelegationInput,key:string)=>request<AutomationGrant>(root+'/delegations','POST',input,{'Idempotency-Key':key}),
  recover:(key:string)=>request<AutomationGrant>(root+'/delegations/by-key/'+encodeURIComponent(key)),
  get:(id:string,credential?:string)=>request<AutomationDelegation>(delegation(id),'GET',undefined,headers(credential)),
  verify:(id:string,scope:AutomationScope,credential?:string)=>request<AutomationVerification>(delegation(id)+'/verify','POST',scope,headers(credential)),
  revoke:(id:string,credential?:string)=>request<AutomationDelegation>(delegation(id),'DELETE',undefined,headers(credential)),
  send:(id:string,credential:string,input:DelegatedMessageInput,key:string)=>request<DelegatedMessageStatus>(delegation(id)+'/messages','POST',input,{...headers(credential),'Idempotency-Key':key}),
  message:(id:string,credential:string,key:string)=>request<DelegatedMessageStatus>(delegation(id)+'/messages/by-key/'+encodeURIComponent(key),'GET',undefined,headers(credential)),
  withdraw:(id:string,credential:string,input:DelegatedMessageInput,key:string)=>request<DelegatedMessageWithdrawal>(delegation(id)+'/messages/by-key/'+encodeURIComponent(key)+'/withdraw','POST',input,headers(credential)),
  webhooks:{
   create:(url:string,key:string)=>request<WebhookRegistration>(root+'/webhooks','POST',{url},{'Idempotency-Key':key}),
   recover:(key:string)=>request<WebhookRegistration>(root+'/webhooks/by-key/'+encodeURIComponent(key))
  }
 };
}
