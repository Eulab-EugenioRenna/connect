/** The application supplies all business content and the number of nodes/levels. */
export type IVRChannel='whatsapp'|'voice';
export type IVRInput={type:'start'|'back'|'restart'}|{type:'text'|'speech'|'dtmf'|'choice';value:string};
export interface IVRPrompt {nodeId:string;text:string;speech:string;expects:'choice'|'text'|'none';choices:{id:string;key:string;label:string;dtmf:string|null}[]}
export interface VoiceIVRSession {id:string;callId:string;revision:number;turn:number;result:WhatsAppBotTurn;expiresAt:string}
export type WhatsAppBotNode=
 |{id:string;type:'menu';text:string;speech?:string;options:{key:string;label:string;next:string;aliases?:string[]}[]}
 |{id:string;type:'question';text:string;speech?:string;next:string}
 |{id:string;type:'end';text:string;speech?:string;outcome?:string};
export interface WhatsAppBotDefinition {name:string;startNodeId:string;trigger:string;sessionTimeoutMinutes:number;invalidReply:string;nodes:WhatsAppBotNode[]}
export interface WhatsAppBotState {nodeId:string;history:string[];answers:Record<string,string>}
export interface WhatsAppBotTurn {reply:string|null;state:WhatsAppBotState|null;completed:boolean;answers:Record<string,string>;outcome?:string;prompt?:IVRPrompt;channel?:IVRChannel}
export interface WhatsAppBot {archiveId:string;revision:number;enabled:boolean;connected:boolean;definition:WhatsAppBotDefinition|null}
