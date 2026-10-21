import {Body,Controller,Get,Param,Post,Put,Req,Headers} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {Authorization} from './authorization.js';
import {parse,uuid} from './validation.js';
import {ApiInput} from './openapi.js';
import {RequestContext} from './auth.js';
import {WhatsAppBotService} from './whatsapp-bot.service.js';
import {botDefinitionSchema,botPreviewSchema,botTurn,ivrInputSchema} from './whatsapp-bot.js';
const configureSchema=z.object({definition:botDefinitionSchema,expectedRevision:z.number().int().min(0)}).strict();
const activationSchema=z.object({enabled:z.boolean(),expectedRevision:z.number().int().min(1)}).strict();
@Controller('v1/installations/:installationId/whatsapp') @ApiTags('WhatsApp Bot') @ApiBearerAuth()
export class WhatsAppBotController {
 constructor(private readonly bots:WhatsAppBotService,private readonly policy:Authorization){}
 private async access(req:RequestContext,id:string,permission:string){parse(uuid,id);await this.policy.require(req.principal,id,permission);}
 @Get('archives/:archiveId/bot') async get(@Param('installationId') i:string,@Param('archiveId') a:string,@Req() req:RequestContext){await this.access(req,i,'whatsapp.read');parse(uuid,a);return this.bots.get(i,a);}
 @Put('archives/:archiveId/bot') @ApiInput(configureSchema) async configure(@Param('installationId') i:string,@Param('archiveId') a:string,@Req() req:RequestContext,@Body() body:unknown){await this.access(req,i,'whatsapp.manage');parse(uuid,a);const b=parse(configureSchema,body);return this.bots.configure(i,a,b.definition,b.expectedRevision,req.principal);}
 @Put('archives/:archiveId/bot/activation') @ApiInput(activationSchema) async activate(@Param('installationId') i:string,@Param('archiveId') a:string,@Req() req:RequestContext,@Body() body:unknown){await this.access(req,i,'whatsapp.manage');parse(uuid,a);const b=parse(activationSchema,body);if(b.enabled)await this.access(req,i,'whatsapp.send');return this.bots.enable(i,a,b.enabled,b.expectedRevision,req.principal);}
 @Post('archives/:archiveId/bot/voice-sessions') @ApiInput(z.object({callId:z.string().min(1).max(200)}).strict())
 async startVoice(@Param('installationId') i:string,@Param('archiveId') a:string,@Req() req:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:string){
  await this.access(req,i,'whatsapp.manage');parse(uuid,a);parse(z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),key);
  const b=parse(z.object({callId:z.string().trim().min(1).max(200)}).strict(),body);return this.bots.startVoice(i,a,b.callId,key,req.principal);
 }
 @Get('archives/:archiveId/bot/voice-sessions/:id')
 async getVoice(@Param('installationId') i:string,@Param('archiveId') a:string,@Param('id') id:string,@Req() req:RequestContext){await this.access(req,i,'whatsapp.manage');parse(uuid,a);parse(uuid,id);return this.bots.getVoice(i,a,id,req.principal);}
 @Post('archives/:archiveId/bot/voice-sessions/:id/turns') @ApiInput(z.object({input:ivrInputSchema,expectedTurn:z.number().int().min(0)}).strict())
 async advanceVoice(@Param('installationId') i:string,@Param('archiveId') a:string,@Param('id') id:string,@Req() req:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:string){
  await this.access(req,i,'whatsapp.manage');parse(uuid,a);parse(uuid,id);parse(z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),key);
  const b=parse(z.object({input:ivrInputSchema,expectedTurn:z.number().int().min(0)}).strict(),body);return this.bots.advanceVoice(i,a,id,b.input,b.expectedTurn,key,req.principal);
 }
 @Post('bot/preview') @ApiInput(botPreviewSchema) async preview(@Param('installationId') i:string,@Req() req:RequestContext,@Body() body:unknown){await this.access(req,i,'whatsapp.manage');const b=parse(botPreviewSchema,body);return {...botTurn(b.definition,b.input,b.state||null,b.channel),sent:false};}
}
