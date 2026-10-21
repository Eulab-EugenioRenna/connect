import {readFile,appendFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const text=await readFile('.env','utf8');
const values={QA_TYPE_PASSWORD:randomBytes(24).toString('hex'),QA_WP_CUSTOMER_PASSWORD:randomBytes(24).toString('hex'),QA_DB_PASSWORD:randomBytes(24).toString('hex'),QA_DB_ROOT_PASSWORD:randomBytes(24).toString('hex'),QA_WP_PASSWORD:randomBytes(24).toString('hex'),QA_OPERATOR_PASSWORD:randomBytes(24).toString('hex'),QA_CUSTOMER_PASSWORD:randomBytes(24).toString('hex'),QA_WP_STORAGE_KEY:randomBytes(32).toString('base64')};
const missing=Object.entries(values).filter(([key])=>!new RegExp(`^${key}=`, 'm').test(text));
if(missing.length)await appendFile('.env','\n# Credenziali locali del collaudo; nessun uso in produzione.\n'+missing.map(([key,v])=>`${key}=${v}`).join('\n')+'\n');
console.log('Configurazione QA locale pronta; segreti conservati soltanto in .env.');
