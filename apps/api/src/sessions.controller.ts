import {Controller,Get,Post,Param,Query,Req} from '@nestjs/common';
import {Admin,RequestContext} from './auth.js';
import {SessionsService} from './sessions.service.js';
import {parse,uuid} from './validation.js';
@Controller('v1/sessions')
export class SessionsController {
 constructor(private readonly sessions:SessionsService){}
 @Get() list(@Req() req:RequestContext,@Query('subject') subject?:string){if(subject)parse(uuid,subject);return this.sessions.list(req.principal,subject);}
 @Post('logout-all') all(@Req() req:RequestContext){return this.sessions.logoutAll(req.principal);}
 @Admin() @Post('users/:subject/logout-all') user(@Req() req:RequestContext,@Param('subject') subject:string){parse(uuid,subject);return this.sessions.logoutAll(req.principal,subject);}
 @Post(':id/logout') one(@Req() req:RequestContext,@Param('id') id:string){parse(uuid,id);return this.sessions.logout(req.principal,id);}
}
