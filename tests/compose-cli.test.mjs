import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('compose wrapper selects production by default and preserves explicit development and Docker arguments',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'connect-compose-cli-'));
 try{
  await writeFile(join(directory,'docker'),"#!/bin/sh\nprintf '%s\\n' \"$@\"\n",{mode:0o700});
  const run=args=>spawnSync(resolve('compose'),args,{encoding:'utf8',cwd:tmpdir(),env:{...process.env,PATH:directory+':'+process.env.PATH}});
  for(const args of [[],['up','-d'],['up','-prod','-d']]){
   const result=run(args);assert.equal(result.status,0,result.stderr);
   assert.deepEqual(result.stdout.trim().split('\n').slice(1),['compose','--env-file','.env.production','-f','compose.yaml','-f','infra/compose.production.yaml',...(args.length?['up','-d']:['up'])]);
  }
  const dev=run(['up','-dev','-d','--build']);assert.equal(dev.status,0,dev.stderr);
  assert.deepEqual(dev.stdout.trim().split('\n').slice(1),['compose','--env-file','.env','-f','compose.yaml','up','-d','--build']);
  assert.equal(run(['up','-dev','-prod']).status,2);
 }finally{await rm(directory,{recursive:true,force:true});}
});
