import {Controller,Get,Post,Put,Delete,Param,Body,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {Admin,RequestContext} from './auth.js';
import {IdentitiesService} from './identities.service.js';
import {ApiInput} from './openapi.js';
import {parse,name,uuid} from './validation.js';
const profile={displayName:name,email:z.union([z.string().email().max(250),z.literal('')]),userType:z.enum(['admin','client'])};
export const createIdentitySchema=z.object({...profile,username:z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/),password:z.string().min(12).max(128),temporaryPassword:z.boolean().default(true)}).strict();
export const updateIdentitySchema=z.object({...profile,enabled:z.boolean()}).strict();
@Controller('v1/sso-identities') @ApiTags('Identità SSO') @ApiBearerAuth() @Admin()
export class IdentitiesController {
 constructor(private readonly identities:IdentitiesService){}
 @Get() list(){return this.identities.list();}
 @Post() @ApiInput(createIdentitySchema) create(@Body() body:unknown,@Req() req:RequestContext){return this.identities.create(parse(createIdentitySchema,body),req.principal.subject!);}
 @Delete(':subject') remove(@Param('subject') subject:string,@Req() req:RequestContext){parse(uuid,subject);return this.identities.remove(subject,req.principal.subject!);}
 @Put(':subject') @ApiInput(updateIdentitySchema) update(@Param('subject') subject:string,@Body() body:unknown,@Req() req:RequestContext){parse(uuid,subject);return this.identities.update(subject,parse(updateIdentitySchema,body),req.principal.subject!);}
}
