import {readdir,lstat,mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.cwd(),dest=resolve('dist/releases');await mkdir(dest,{recursive:true});
const roots=['apps','packages','scripts','infra','plugins','assets','tests','docs','README.md','CONTEXT.md','package.json','package-lock.json','tsconfig.json','Dockerfile','compose','compose.yaml','.dockerignore','.env.example'];
const files=[];
async function collect(name){
 const base=name.split('/').at(-1);
 if(['node_modules','dist','.git','target','backups','verification','.DS_Store','pairing.local.php'].includes(base)||base.startsWith('.env')&&base!=='.env.example')return;
 const info=await lstat(join(root,name));
 if(info.isSymbolicLink())return;
 if(info.isDirectory()){for(const entry of await readdir(join(root,name)))await collect(name+'/'+entry);}
 else if(info.isFile())files.push(name);
}
for(const name of roots)await collect(name);
files.sort();
const scratch=await mkdtemp(join(tmpdir(),'connect-package-'));
try{
 const list=join(scratch,'files');await writeFile(list,files.join('\0')+'\0');
 const target=join(dest,'eulab-connect-source.tar.gz');
 const result=spawnSync('tar',['-czf',target,'--null','-T',list],{cwd:root,stdio:'inherit'});if(result.status!==0)throw new Error('Creazione archivio fallita');
 const sha256=createHash('sha256').update(await readFile(target)).digest('hex');
 await writeFile(target+'.sha256',`${sha256}  eulab-connect-source.tar.gz\n`);
 await writeFile(join(dest,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),sdkVersion:'0.9.0',providerVersion:'1.0.0',schema:'011',archive:relative(root,target),sha256,files:files.length,containsEnvironmentSecrets:false},null,2)+'\n');
 console.log(`Pacchetto sorgente: ${relative(root,target)} (${files.length} file). SHA-256: ${sha256}`);
 console.log('Esclusi ambienti privati, dipendenze locali, profili WhatsApp, backup, sorgenti provider e artefatti di build.');
}finally{await rm(scratch,{recursive:true,force:true});}
