import {BadRequestException,Body,Controller,Delete,Get,Headers,Param,Post,Put,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {Admin,Public,RequestContext} from './auth.js';
import {ApiInput} from './openapi.js';
import {parse,uuid} from './validation.js';
import {OnboardingService} from './onboarding.service.js';
import {
  presenterSchema,presenterUpdateSchema,sourceConfigurationSchema,bindSourceInstallationSchema,connectSourceSchema,loginContextSchema,onboardingPlanSchema,
  passwordRecoverySchema,onboardingRequestSchema,rejectOnboardingSchema,sourceId as sourceIdSchema,sourceLocalUserSchema,updateConnectSourceSchema
} from './onboarding.schemas.js';

/**
 * Contratto backend-to-backend usato dalla sorgente di deployment (ALORA).
 * La sorgente e' autenticata dal bearer bootstrap: la lookup non autentica
 * l'utente e non crea sessioni. Nessun segreto viene restituito in questa
 * classe oltre al contesto autorizzato dell'installazione.
 */
@Controller('v1/app-onboarding') @ApiTags('Onboarding applicazioni')
export class AppOnboardingController {
 constructor(private readonly onboarding:OnboardingService){}

 @Public() @Post('login-context')
 async loginContext(@Body() body:unknown,@Req() req:any){
  const source=await this.onboarding.authenticate(req,body);
  const input=parse(loginContextSchema,body);
  return this.onboarding.loginContext(source,input.email);
 }

 @Public() @Post('password-recovery') @ApiInput(passwordRecoverySchema)
 async recoverPassword(@Body() body:unknown,@Headers('idempotency-key') key:string|undefined,@Req() req:any){
  if(!key)throw new BadRequestException('Idempotency-Key richiesta');
  const source=await this.onboarding.authenticate(req,body);
  return this.onboarding.recoverPassword(source,parse(passwordRecoverySchema,body),key);
 }

 @Public() @Post('configuration')
 async configuration(@Body() body:unknown,@Req() req:any){const source=await this.onboarding.authenticate(req,body);parse(sourceConfigurationSchema,body);return this.onboarding.configuration(source);}

 @Public() @Post('requests')
 async submitRequest(@Body() body:unknown,@Headers('idempotency-key') idempotencyKey:string|undefined,@Req() req:any){
  if(!idempotencyKey)throw new BadRequestException('Idempotency-Key richiesta');
  const source=await this.onboarding.authenticate(req,body);
  const input=parse(onboardingRequestSchema,body);
  return this.onboarding.submit(source,input,idempotencyKey);
 }
}

/** Gestione EULAB: sorgenti di deployment, collegamenti e pratiche. */
@Controller('v1') @ApiTags('Onboarding') @ApiBearerAuth() @Admin()
export class OnboardingAdminController {
 constructor(private readonly onboarding:OnboardingService){}

 @Get('onboarding/presenters') presenters(){return this.onboarding.listPresenters();}
 @Post('onboarding/presenters') @ApiInput(presenterSchema)
 presenter(@Body() body:unknown,@Req() req:RequestContext){return this.onboarding.issuePresenter(parse(presenterSchema,body),req.principal.subject!);}
 @Put('onboarding/presenters/:id')
 updatePresenter(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){return this.onboarding.updatePresenter(parse(uuid,id),parse(presenterUpdateSchema,body),req.principal.subject!);}

 @Get('connect-sources') sources(){return this.onboarding.listSources();}

 @Get('connect-sources/:id') source(@Param('id') id:string){return this.onboarding.sourceDetail(parse(sourceIdSchema,id));}

 @Post('connect-sources') @ApiInput(connectSourceSchema)
 createSource(@Body() body:unknown,@Req() req:RequestContext){return this.onboarding.createSource(parse(connectSourceSchema,body),req.principal.subject!);}

 @Put('connect-sources/:id') @ApiInput(updateConnectSourceSchema)
 updateSource(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  return this.onboarding.updateSource(parse(sourceIdSchema,id),parse(updateConnectSourceSchema,body),req.principal.subject!);
 }

 @Post('connect-sources/:id/installations') @ApiInput(bindSourceInstallationSchema)
 bindInstallation(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  return this.onboarding.bindInstallation(parse(sourceIdSchema,id),parse(bindSourceInstallationSchema,body).installationId,req.principal.subject!);
 }

 @Post('connect-sources/:id/local-users') @ApiInput(sourceLocalUserSchema)
 preassignLocalUser(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  return this.onboarding.preassignLocalUser(parse(sourceIdSchema,id),parse(sourceLocalUserSchema,body),req.principal.subject!);
 }

 @Delete('connect-sources/:id/local-users/:installationId/:localUserId')
 removeLocalUser(@Param('id') id:string,@Param('installationId') installationId:string,@Param('localUserId') localUserId:string,@Req() req:RequestContext){
  return this.onboarding.removeLocalUser(parse(sourceIdSchema,id),parse(uuid,installationId),localUserId,req.principal.subject!);
 }

 @Get('onboarding/practices') practices(){return this.onboarding.listPractices();}

 @Get('onboarding/practices/:id') practice(@Param('id') id:string){return this.onboarding.practiceDetail(parse(uuid,id));}

 @Put('onboarding/practices/:id/plan') @ApiInput(onboardingPlanSchema)
 savePlan(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  return this.onboarding.savePlan(parse(uuid,id),parse(onboardingPlanSchema,body),req.principal.subject!);
 }

 @Get('onboarding/practices/:id/resolution') resolution(@Param('id') id:string){
  return this.onboarding.resolutionProposal(parse(uuid,id));
 }

 @Post('onboarding/practices/:id/resolve') @ApiInput(onboardingPlanSchema)
 resolve(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  return this.onboarding.resolvePractice(parse(uuid,id),parse(onboardingPlanSchema,body),req.principal.subject!);
 }

 @Post('onboarding/practices/:id/prepare') prepare(@Param('id') id:string,@Req() req:RequestContext){
  return this.onboarding.preparePractice(parse(uuid,id),req.principal.subject!);
 }

 @Post('onboarding/practices/:id/execute') execute(@Param('id') id:string,@Req() req:RequestContext){
  return this.onboarding.executePractice(parse(uuid,id),req.principal.subject!);
 }

 @Post('onboarding/practices/:id/reject') @ApiInput(rejectOnboardingSchema)
 rejectPractice(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  return this.onboarding.rejectPractice(parse(uuid,id),parse(rejectOnboardingSchema,body).reason,req.principal.subject!);
 }

 @Post('onboarding/practices/:id/requests/:requestId/reject') @ApiInput(rejectOnboardingSchema)
 rejectRequest(@Param('id') id:string,@Param('requestId') requestId:string,@Body() body:unknown,@Req() req:RequestContext){
  return this.onboarding.rejectRequest(parse(uuid,id),parse(uuid,requestId),parse(rejectOnboardingSchema,body).reason,req.principal.subject!);
 }
}
