import {Injectable,ServiceUnavailableException} from '@nestjs/common';
import nodemailer from 'nodemailer';
import {z} from 'zod';
const configSchema=z.object({host:z.string().min(1).max(253),port:z.coerce.number().int().min(1).max(65535),from:z.string().email(),user:z.string(),password:z.string(),security:z.enum(['starttls','tls'])});
export function smtpConfig(){
 const result=configSchema.safeParse({host:process.env.SMTP_HOST,port:process.env.SMTP_PORT||587,from:process.env.SMTP_FROM,user:process.env.SMTP_USER||'',password:process.env.SMTP_PASSWORD||'',security:process.env.SMTP_SECURITY||'starttls'});
 if(!result.success)throw new ServiceUnavailableException('Configura SMTP_HOST, SMTP_PORT, SMTP_FROM e credenziali SMTP nel file ambiente');
 if(!!result.data.user!==!!result.data.password)throw new ServiceUnavailableException('Configurazione credenziali SMTP incompleta');
 return result.data;
}
@Injectable()
export class MailService {
 status(){try{const c=smtpConfig();return {configured:true,host:c.host,port:c.port,from:c.from,security:c.security};}catch{return {configured:false};}}
 async send(to:string,subject:string,text:string){
  const c=smtpConfig();
  const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.security==='tls',requireTLS:c.security==='starttls',auth:c.user?{user:c.user,pass:c.password}:undefined,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false});
  return transport.sendMail({from:{name:'EULab Connect',address:c.from},to:{address:to,name:''},subject,text});
 }
}
