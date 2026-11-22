import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const script=resolve('scripts/prune-runtime-deps.mjs');
test('runtime pruning preserves executable assets, licenses and symlink targets',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'connect-prune-'));
 try{
  const root=join(temp,'node_modules'),pkg=join(root,'provider');
  await mkdir(join(pkg,'dist'),{recursive:true});
  await mkdir(join(pkg,'tests'));
  for(const name of ['index.mjs','worker.cjs','wapi.js','module.wasm','config.json','LICENSE.md','NOTICE','declaration.d.ts','index.mjs.map','README.md','license.ts','NOTICE.map','COPYING.cts'])await writeFile(join(pkg,'dist',name),name);
  await writeFile(join(pkg,'tests','unit.js'),'test');
  const outside=join(temp,'outside');await mkdir(outside);await writeFile(join(outside,'keep.ts'),'keep');await symlink(outside,join(pkg,'linked'));
  const result=spawnSync(process.execPath,[script,root],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  for(const name of ['index.mjs','worker.cjs','wapi.js','module.wasm','config.json','LICENSE.md','NOTICE'])assert.equal(await readFile(join(pkg,'dist',name),'utf8'),name);
  for(const name of ['declaration.d.ts','index.mjs.map','README.md','license.ts','NOTICE.map','COPYING.cts'])await assert.rejects(access(join(pkg,'dist',name)));
  await assert.rejects(access(join(pkg,'tests')));
  assert.equal(await readFile(join(outside,'keep.ts'),'utf8'),'keep');
  assert.notEqual(spawnSync(process.execPath,[script,temp]).status,0);
  assert.equal(await readFile(join(outside,'keep.ts'),'utf8'),'keep');
 }finally{await rm(temp,{recursive:true,force:true});}
});
