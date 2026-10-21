import {Body,Controller,Get,Put,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {Admin,RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {IdentitiesService} from './identities.service.js';
import {ApiInput} from './openapi.js';
import {parse} from './validation.js';
export const ssoSettingsSchema=z.object({accessTokenLifespan:z.number().int().min(60).max(3600),ssoSessionIdleTimeout:z.number().int().min(300).max(604800),ssoSessionMaxLifespan:z.number().int().min(300).max(2592000),syncClients:z.boolean()}).strict().refine(v=>v.accessTokenLifespan<v.ssoSessionIdleTimeout&&v.ssoSessionIdleTimeout<=v.ssoSessionMaxLifespan,'Timeout token < inattività SSO ≤ durata massima');
@Controller('v1/sso-settings') @ApiTags('Configurazione SSO') @ApiBearerAuth() @Admin()
export class SsoController {
 constructor(private readonly identities:IdentitiesService,private readonly db:Database){}
 @Get() async settings(){
  const realm=(await this.identities.request('')).body;
  const clients=(await this.identities.request('/clients?max=1000')).body;
  return {accessTokenLifespan:realm.accessTokenLifespan,ssoSessionIdleTimeout:realm.ssoSessionIdleTimeout,ssoSessionMaxLifespan:realm.ssoSessionMaxLifespan,clients:clients.filter((c:any)=>c.standardFlowEnabled).map((c:any)=>({clientId:c.clientId,redirectUris:c.redirectUris,overrides:Object.fromEntries(['access.token.lifespan','client.session.idle.timeout','client.session.max.lifespan'].filter(k=>c.attributes?.[k]&&c.attributes[k]!=='0').map(k=>[k,c.attributes[k]]))}))};
 }
 @Put() @ApiInput(ssoSettingsSchema) async save(@Body() body:unknown,@Req() req:RequestContext){
  const b=parse(ssoSettingsSchema,body),actor=req.principal.subject!;
  await this.db.transaction(tx=>audit(tx,actor,'sso.settings.update.requested','eulab',b));
  await this.identities.request('','PUT',{accessTokenLifespan:b.accessTokenLifespan,ssoSessionIdleTimeout:b.ssoSessionIdleTimeout,ssoSessionMaxLifespan:b.ssoSessionMaxLifespan});
  const synced:string[]=[],failed:string[]=[];
  if(b.syncClients){
   const clients=(await this.identities.request('/clients?max=1000')).body;
   for(const c of clients.filter((c:any)=>c.standardFlowEnabled)){
    const attributes={...c.attributes};for(const k of ['access.token.lifespan','client.session.idle.timeout','client.session.max.lifespan'])delete attributes[k];
    try{await this.identities.request(`/clients/${c.id}`,'PUT',{attributes});synced.push(c.clientId);}catch{failed.push(c.clientId);}
   }
  }
  await this.db.transaction(tx=>audit(tx,actor,failed.length?'sso.settings.update.partial':'sso.settings.update','eulab',{...b,synced,failed}));
  return {...await this.settings(),synced,failed};
 }
}
