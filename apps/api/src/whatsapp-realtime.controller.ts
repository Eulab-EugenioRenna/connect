import {Controller,Param,Post,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {RequestContext} from './auth.js';
import {parse,uuid} from './validation.js';
import {WhatsAppRealtimeService} from './whatsapp-realtime.service.js';
@Controller('v1/installations/:installationId/whatsapp') @ApiTags('WhatsApp realtime') @ApiBearerAuth()
export class WhatsAppRealtimeController {
 constructor(private readonly realtime:WhatsAppRealtimeService){}
 @Post('events/ticket') async ticket(@Param('installationId') id:string,@Req() req:RequestContext){
  parse(uuid,id);let origin=req.headers.origin;
  if(!origin&&req.headers.referer){try{origin=new URL(req.headers.referer).origin;}catch{}}
  return this.realtime.ticket(id,req.principal,origin);
 }
}
