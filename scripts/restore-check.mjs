import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const directory=process.argv[2];if(!directory)throw new Error('Uso: node scripts/restore-check.mjs backups/<snapshot>');
const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
for(const [name,expected]of Object.entries(manifest.files)){if(name!=='database.dump'&&!/^profiles-[a-zA-Z0-9_-]+\.tar\.gz$/.test(name))throw new Error('Manifest non valido');if(createHash('sha256').update(await readFile(resolve(directory,name))).digest('hex')!==expected)throw new Error(`Checksum errato: ${name}`);}
const check=spawnSync('docker',['compose','exec','-T','postgres','pg_restore','--list'],{input:await readFile(resolve(directory,'database.dump')),encoding:'utf8'});
if(check.status!==0)throw new Error('Dump non leggibile: avvia PostgreSQL con Docker per verificarlo.');
console.log('Checksum e indice del dump verificati. Il ripristino integrale in ambiente separato resta necessario.');
