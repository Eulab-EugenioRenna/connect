import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const output=await mkdtemp(join(tmpdir(),'eulab-mfa-test-'));
try{
 for(const [cmd,args] of [['javac',['-d',output,'infra/keycloak/providers/email-otp/src/main/java/cloud/eulab/connect/SecurityTokens.java','tests/keycloak/SecurityTokensTest.java']],['java',['-cp',output,'cloud.eulab.connect.SecurityTokensTest']]]){
  const result=spawnSync(cmd,args,{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw new Error(cmd+' terminato con codice '+result.status);
 }
}finally{await rm(output,{recursive:true,force:true});}
