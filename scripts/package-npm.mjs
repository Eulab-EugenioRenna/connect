import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'eulab-npm-bundle-'));
const output=resolve(root,'dist/releases/npm');
const env={...process.env,PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN:'false',PNPM_CONFIG_UPDATE_NOTIFIER:'false',EULAB_NPM_ARTIFACTS:scratch};
function run(command,args,cwd=root,capture=false){
 const result=spawnSync(command,args,{cwd,env,encoding:'utf8',stdio:capture?'pipe':'inherit',maxBuffer:16*1024*1024});
 if(result.error||result.status!==0)throw new Error(result.error?.message||result.stderr||`${command}: codice ${result.status}`);
 return result.stdout;
}
try{
 const provider=join(root,'openwaunlocked');
 run('npm',['run','release:npm:build'],provider);
 run('npm',['run','release:npm:pack'],provider);
 const records=JSON.parse(await readFile(join(scratch,'manifest.json'),'utf8'));
 const [sdk]=JSON.parse(run('npm',['pack','--json','--pack-destination',scratch],join(root,'packages/sdk'),true));
 assert.equal(sdk.name,'@eulab/connect');
 assert(sdk.files.every(({path})=>path==='package.json'||path==='README.md'||/^dist\/.*\.(js|d\.ts)$/.test(path)),'Contenuto SDK inatteso');
 for(const file of ['browser.js','server.js','browser.d.ts','server.d.ts'])assert(sdk.files.some(({path})=>path==='dist/'+file),file);
 records.push({name:sdk.name,version:sdk.version,filename:sdk.filename,files:sdk.files.length});
 for(const record of records){
  const data=await readFile(join(scratch,record.filename));
  record.bytes=data.length;
  record.sha256=createHash('sha256').update(data).digest('hex');
 }
 await writeFile(join(scratch,'manifest.json'),JSON.stringify(records,null,2)+'\n');
 await writeFile(join(scratch,'SHA256SUMS'),records.map(r=>`${r.sha256}  ${r.filename}`).join('\n')+'\n');
 await mkdir(join(root,'dist/releases'),{recursive:true});
 // Replace only this generated release directory after all packages pass.
 await rm(output,{recursive:true,force:true});
 await cp(scratch,output,{recursive:true});
 const archive=join(root,'dist/releases/eulab-npm-bundle.tar.gz');
 run('tar',['-czf',archive,'-C',output,'manifest.json','SHA256SUMS',...records.map(r=>r.filename)]);
 const archiveHash=createHash('sha256').update(await readFile(archive)).digest('hex');
 await writeFile(archive+'.sha256',`${archiveHash}  eulab-npm-bundle.tar.gz\n`);
 console.log(`${records.length} tarball verificati in ${output}`);
 console.log('Archivio: dist/releases/eulab-npm-bundle.tar.gz. Nessuna pubblicazione eseguita.');
}finally{await rm(scratch,{recursive:true,force:true});}
