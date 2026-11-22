import {Body,Controller,Delete,ForbiddenException,Get,Headers,Param,Post,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {AutomationService} from './automation.service.js';
import {WebhookRegistrationService} from './webhook-registration.service.js';
import type {RequestContext} from './auth.js';
import {parse,uuid} from './validation.js';
import {ApiInput} from './openapi.js';
import {delegationSchema,delegatedMessageSchema,idempotencyKeySchema,verificationSchema} from './automation-contract.js';
import {whatsappWebhookSchema} from './schemas.js';
/** All credential operations are backend-only, including authenticated recovery. */
export function automationServer(req:RequestContext,i:string,personal=false){
 parse(uuid,i);
 if(!req.principal.server||req.principal.installationId!==i||req.headers.origin||req.headers['sec-fetch-site']||personal&&!req.principal.subject)throw new ForbiddenException('server_authorization_required');
}
@Controller('v1/installations/:installationId/automations') @ApiTags('Automations') @ApiBearerAuth()
export class AutomationController {
 constructor(private readonly service:AutomationService,private readonly webhooks:WebhookRegistrationService){}
 @Post('delegations') @ApiInput(delegationSchema) create(@Param('installationId') i:string,@Req() r:RequestContext,@Body() b:unknown,@Headers('idempotency-key') k:string){automationServer(r,i,true);return this.service.create(i,r.principal,parse(delegationSchema,b),parse(idempotencyKeySchema,k));}
 @Get('delegations/by-key/:key') recover(@Param('installationId') i:string,@Param('key') k:string,@Req() r:RequestContext){automationServer(r,i,true);return this.service.recover(i,r.principal.subject!,parse(idempotencyKeySchema,k));}
 @Get('delegations/:id') get(@Param('installationId') i:string,@Param('id') id:string,@Req() r:RequestContext,@Headers('x-connect-delegation') c?:string){automationServer(r,i);parse(uuid,id);return this.service.get(i,id,r.principal,c);}
 @Post('delegations/:id/verify') @ApiInput(verificationSchema) verify(@Param('installationId') i:string,@Param('id') id:string,@Req() r:RequestContext,@Body() b:unknown,@Headers('x-connect-delegation') c?:string){automationServer(r,i);parse(uuid,id);return this.service.verify(i,id,r.principal,c,parse(verificationSchema,b));}
 @Delete('delegations/:id') revoke(@Param('installationId') i:string,@Param('id') id:string,@Req() r:RequestContext,@Headers('x-connect-delegation') c?:string){automationServer(r,i);parse(uuid,id);return this.service.revoke(i,id,r.principal,c);}
 @Post('delegations/:id/messages') @ApiInput(delegatedMessageSchema) send(@Param('installationId') i:string,@Param('id') id:string,@Req() r:RequestContext,@Body() b:unknown,@Headers('idempotency-key') k:string,@Headers('x-connect-delegation') c:string){automationServer(r,i);parse(uuid,id);if(!c)throw new ForbiddenException('delegation_credential_required');return this.service.send(i,id,r.principal,c,parse(delegatedMessageSchema,b),parse(idempotencyKeySchema,k));}
 @Get('delegations/:id/messages/by-key/:key') message(@Param('installationId') i:string,@Param('id') id:string,@Param('key') k:string,@Req() r:RequestContext,@Headers('x-connect-delegation') c:string){automationServer(r,i);parse(uuid,id);if(!c)throw new ForbiddenException('delegation_credential_required');return this.service.message(i,id,r.principal,c,parse(idempotencyKeySchema,k));}
 @Post('delegations/:id/messages/by-key/:key/withdraw') @ApiInput(delegatedMessageSchema) withdraw(@Param('installationId') i:string,@Param('id') id:string,@Param('key') k:string,@Req() r:RequestContext,@Body() b:unknown,@Headers('x-connect-delegation') c:string){automationServer(r,i);parse(uuid,id);if(!c)throw new ForbiddenException('delegation_credential_required');return this.service.withdraw(i,id,r.principal,c,parse(delegatedMessageSchema,b),parse(idempotencyKeySchema,k));}
 @Post('webhooks') @ApiInput(whatsappWebhookSchema) webhook(@Param('installationId') i:string,@Req() r:RequestContext,@Body() b:unknown,@Headers('idempotency-key') k:string){automationServer(r,i,true);return this.webhooks.create(i,r.principal,parse(whatsappWebhookSchema,b),parse(idempotencyKeySchema,k));}
 @Get('webhooks/by-key/:key') recoverWebhook(@Param('installationId') i:string,@Param('key') k:string,@Req() r:RequestContext){automationServer(r,i,true);return this.webhooks.recover(i,r.principal,parse(idempotencyKeySchema,k));}
}
