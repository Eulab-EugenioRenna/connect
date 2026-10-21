import {readFile,writeFile} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),directory=process.argv[2];if(!directory)throw new Error('Indica il backup da verificare');
const manifest=JSON.parse(await readFile(directory+'/manifest.json','utf8'));
for(const [file,checksum]of Object.entries(manifest.files)){if(!/^(database\.dump|profiles-[a-zA-Z0-9_-]+\.tar\.gz)$/.test(file))throw new Error('Nome file non consentito');if(createHash('sha256').update(await readFile(directory+'/'+file)).digest('hex')!==checksum)throw new Error('Checksum errato');}
const project=['compose','--project-name','eulab-connect-restore','-f','compose.yaml'];
await exec('docker',[...project,'up','-d','postgres']);
for(let n=0;n<30;n++){try{await exec('docker',[...project,'exec','-T','postgres','pg_isready','-U','connect']);break;}catch{if(n===29)throw new Error('PostgreSQL ripristino non disponibile');await new Promise(r=>setTimeout(r,1000));}}
const dbName='restore_'+Date.now();await exec('docker',[...project,'exec','-T','postgres','createdb','-U','connect',dbName]);
async function input(args,data){await new Promise((resolve,reject)=>{const child=spawn('docker',args,{stdio:['pipe','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b.toString());child.on('error',reject);child.on('close',code=>code?reject(new Error(error)):resolve());child.stdin.on('error',()=>{});child.stdin.end(data);});}
const start=Date.now();await input([...project,'exec','-T','postgres','pg_restore','--exit-on-error','--no-owner','-U','connect','-d',dbName],await readFile(directory+'/database.dump'));
const tables=['customers','applications','installations','identities','licenses','roles','local_links','wa_archives','wa_sessions','messages','outbox','audit','schema_migrations'];const counts={};
for(const table of tables){const r=await exec('docker',[...project,'exec','-T','postgres','psql','-U','connect','-d',dbName,'-At','-c',`SELECT count(*) FROM ${table}`]);counts[table]=Number(r.stdout.trim());}
const profileVolumes=[];
for(const file of Object.keys(manifest.files).filter(f=>f.startsWith('profiles-'))){const volume=`eulab-connect-restore_${file.slice(0,-7)}_${Date.now()}`;await exec('docker',['volume','create',volume]);await input(['run','--rm','--interactive','--network','none','--user','root','--volume',`${volume}:/profiles`,'--entrypoint','tar','eulab-connect-runner:latest','-C','/profiles','-xzf','-'],await readFile(directory+'/'+file));profileVolumes.push(volume);}
const result={status:'passed',at:new Date().toISOString(),backup:directory,database:dbName,isolatedProject:'eulab-connect-restore',restoredRows:counts,restoredProfileVolumes:profileVolumes,restoreDurationMs:Date.now()-start,originalDatabaseUntouched:true,restoredRunnersStarted:false};
await writeFile('docs/verification/restore-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
