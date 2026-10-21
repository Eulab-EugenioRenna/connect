import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),target=`backups/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(target,{recursive:true,mode:0o700});
async function output(args,file,gzip=false){
 const child=spawn('docker',args,{stdio:['ignore','pipe','inherit']});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`Comando Docker fallito (${code})`)));});
 const sink=createWriteStream(file,{mode:0o600});
 await Promise.all([exited,gzip?pipeline(child.stdout,createGzip(),sink):pipeline(child.stdout,sink)]);
}
const ids=(await exec('docker',['compose','ps','--all','--quiet'])).stdout.trim().split(/\s+/).filter(Boolean);
if(!ids.length)throw new Error('Stack non presente: nessun backup creato.');
// Inspect internally; never print container environments, which may contain secrets.
const containers=JSON.parse((await exec('docker',['inspect',...ids],{maxBuffer:10*1024*1024})).stdout);
const writers=containers.filter(c=>['web','api','keycloak'].includes(c.Config.Labels['com.docker.compose.service'])||c.Mounts.some(m=>m.Destination==='/profiles'));
const running=writers.filter(c=>c.State.Running).map(c=>c.Id),profiles=writers.filter(c=>c.Mounts.some(m=>m.Destination==='/profiles'));
let paused=false;
try{
 if(running.length){paused=true;await exec('docker',['stop',...running]);}
 await output(['compose','exec','-T','postgres','pg_dump','-U','connect','-d','connect','-Fc'],`${target}/database.dump`);
 const files=['database.dump'];
 for(const container of profiles){const service=container.Config.Labels['com.docker.compose.service'];if(!/^[a-zA-Z0-9_-]+$/.test(service))throw new Error('Nome runner non valido');const file=`profiles-${service}.tar.gz`;await output(['cp',`${container.Id}:/profiles/.`,'-'],`${target}/${file}`,true);files.push(file);}
 const checksums={};for(const file of files)checksums[file]=createHash('sha256').update(await readFile(`${target}/${file}`)).digest('hex');
 await writeFile(`${target}/manifest.json`,JSON.stringify({createdAt:new Date().toISOString(),schema:'001',files:checksums,runnerProfiles:profiles.map(c=>({service:c.Config.Labels['com.docker.compose.service'],volume:c.Mounts.find(m=>m.Destination==='/profiles').Name})),quiesced:true,redisRebuiltFromDatabase:true,encryptionKeyRequired:true},null,2)+'\n',{mode:0o600});
 console.log(`Backup completato: ${target}. Conserva separatamente DATA_ENCRYPTION_KEY e le configurazioni .env.`);
}finally{if(paused)await exec('docker',['start',...running]);}
