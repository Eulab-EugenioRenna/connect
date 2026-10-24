import {WhatsAppOperationsController} from './whatsapp-operations.controller.js';
import {WhatsAppRealtimeController} from './whatsapp-realtime.controller.js';
import {WhatsAppRealtimeService} from './whatsapp-realtime.service.js';
import {WhatsAppBotController} from './whatsapp-bot.controller.js';
import {WhatsAppBotService} from './whatsapp-bot.service.js';
import {MailService} from './mail.service.js';
import {NotificationsController} from './notifications.controller.js';
import {AccountSecurityController} from './account-security.controller.js';
import {UserMirrorsController} from './user-mirrors.controller.js';
import {TeamController} from './team.controller.js';
import {OnboardingService} from './onboarding.service.js';
import {AppOnboardingController,OnboardingAdminController} from './onboarding.controller.js';
import {GuardianController} from './guardian.controller.js';
import {SessionsController} from './sessions.controller.js';
import {SessionsService} from './sessions.service.js';
import {FunctionsController} from './functions.controller.js';
import {CatalogSourceService} from './catalog-source.service.js';
import {CatalogReader} from './catalog-reader.js';
import {WordPressController} from './wordpress.controller.js';
import {SsoController} from './sso.controller.js';
import 'reflect-metadata';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { Module, Controller, Get, Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import {IdentitiesService} from './identities.service.js';
import {IdentitiesController} from './identities.controller.js';
import {CatalogService} from './catalog.service.js';
import { AuthGuard, Public } from './auth.js';
import { Database } from './database.js';
import { Authorization } from './authorization.js';
import { AdminController } from './admin.controller.js';
import { ConnectorsController } from './connectors.controller.js';
import { WhatsAppService } from './whatsapp.service.js';
import { WhatsAppController } from './whatsapp.controller.js';
@Controller('v1') class HealthController {
 constructor(private readonly db:Database) {}
 @Public() @Get('health') async health(){await this.db.query('SELECT 1');return {status:'ok',service:'eulab-connect',capacityVerified:false};}
}
@Catch() class Errors implements ExceptionFilter {
 catch(error:any,host:ArgumentsHost){const res=host.switchToHttp().getResponse();if(error instanceof HttpException)return res.status(error.getStatus()).json(error.getResponse());
 const status=error.code==='23505'?409:['23503','23514','22P02'].includes(error.code)?400:500;
 if(status===500)console.error('Errore interno',error.code||error.name);res.status(status).json({statusCode:status,message:status===409?'Record già presente':status===400?'Relazione o dato non valido':'Errore interno'});}
}
@Module({controllers:[WhatsAppOperationsController,WhatsAppRealtimeController,WhatsAppBotController,NotificationsController,AccountSecurityController,UserMirrorsController,TeamController,GuardianController,SessionsController,FunctionsController,WordPressController,SsoController,HealthController,IdentitiesController,AdminController,ConnectorsController,WhatsAppController,AppOnboardingController,OnboardingAdminController],providers:[WhatsAppRealtimeService,WhatsAppBotService,MailService,SessionsService,CatalogSourceService,CatalogReader,Database,IdentitiesService,Authorization,CatalogService,WhatsAppService,OnboardingService,{provide:APP_GUARD,useClass:AuthGuard},{provide:APP_FILTER,useClass:Errors}]}) export class AppModule {}
export async function configureApp(app:any){
// Express defaults would reject supported media payloads; explicit bounded parser.
const express=await import('express');app.use(express.json({limit:'15mb'}));
app.enableCors({origin:true,credentials:false,allowedHeaders:['Authorization','Content-Type','X-Installation-Id','X-Installation-Secret','X-Connect-Source','Idempotency-Key']});
app.use((_req:any,res:any,next:()=>void)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
app.enableShutdownHooks();
app.get(WhatsAppRealtimeService).attach(app.getHttpServer());
const document=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('EULab Connect').setVersion('1.0').addBearerAuth().addApiKey({type:'apiKey',in:'header',name:'X-Installation-Secret'},'installation').build());
SwaggerModule.setup('v1/docs',app,document);
return app;
}
