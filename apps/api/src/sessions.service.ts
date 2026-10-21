import {Injectable,ForbiddenException,NotFoundException} from '@nestjs/common';
import {IdentitiesService} from './identities.service.js';
import {Database,audit} from './database.js';
import type {Principal} from './auth.js';
@Injectable()
export class SessionsService {
 constructor(private readonly identities:IdentitiesService,private readonly db:Database){}
 private map(s:any,current?:string){return {id:s.id,subject:s.userId,username:s.username,ipAddress:s.ipAddress,startedAt:s.start,lastAccess:s.lastAccess,clients:Object.values(s.clients||{}),current:s.id===current};}
 async list(p:Principal,subject?:string){
  if(!p.subject)throw new ForbiddenException('Utente richiesto');
  if(subject&&!p.admin&&subject!==p.subject)throw new ForbiddenException();
  if(subject||!p.admin){const rows=(await this.identities.request(`/users/${encodeURIComponent(subject||p.subject)}/sessions`)).body;return {sessions:rows.map((s:any)=>this.map(s,p.sessionId)),truncated:false};}
  const stats=(await this.identities.request('/client-session-stats')).body;const sessions=new Map<string,any>();let truncated=false;
  for(const stat of stats){if(!Number(stat.active))continue;let first=0;while(first<500){const rows=(await this.identities.request(`/clients/${encodeURIComponent(stat.id)}/user-sessions?first=${first}&max=100`)).body;for(const s of rows)sessions.set(s.id,this.map(s,p.sessionId));first+=rows.length;if(rows.length<100)break;if(first>=500)truncated=true;}}
  return {sessions:[...sessions.values()].sort((a,b)=>b.lastAccess-a.lastAccess),truncated};
 }
 async logout(p:Principal,id:string){
  if(!p.subject)throw new ForbiddenException();
  // Ownership is checked against Keycloak, never against a caller supplied subject.
  if(!p.admin&&!(await this.list(p)).sessions.some((s:any)=>s.id===id))throw new NotFoundException('Sessione non trovata');
  await this.db.transaction(tx=>audit(tx,p.subject!,'sso.session.logout.requested',id));
  await this.identities.request(`/sessions/${encodeURIComponent(id)}`,'DELETE');
  await this.db.transaction(tx=>audit(tx,p.subject!,'sso.session.logout',id));return {loggedOut:true,current:id===p.sessionId};
 }
 async logoutAll(p:Principal,subject=p.subject){
  if(!p.subject||!subject||(!p.admin&&subject!==p.subject))throw new ForbiddenException();
  await this.db.transaction(tx=>audit(tx,p.subject!,'sso.sessions.logout.requested',subject));
  await this.identities.request(`/users/${encodeURIComponent(subject)}/logout`,'POST');
  await this.db.transaction(tx=>audit(tx,p.subject!,'sso.sessions.logout',subject));return {loggedOut:true};
 }
 async logoutForPlan(customerId:string,appId:string,actor:string){
  const users=await this.db.query(`SELECT DISTINCT m.subject FROM memberships m WHERE m.customer_id=$1 AND (EXISTS(SELECT 1 FROM assignments a WHERE a.subject=m.subject AND a.customer_id=$1 AND a.app_id=$2) OR EXISTS(SELECT 1 FROM local_links l JOIN installations i ON i.id=l.installation_id WHERE l.subject=m.subject AND i.customer_id=$1 AND i.app_id=$2))`,[customerId,appId]);
  const completed:string[]=[],failed:string[]=[];
  for(const {subject} of users){try{await this.logoutAll({subject:actor,admin:true,technician:true,server:false},subject);completed.push(subject);}catch{failed.push(subject);}}
  return {completed,failed};
 }
}
