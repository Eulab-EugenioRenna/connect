import pg from 'pg';
import {mkdir,writeFile} from 'node:fs/promises';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL richiesta; nessuna sessione viene creata automaticamente.');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
 const {rows:runners}=await pool.query(`SELECT r.id,r.capacity,r.heartbeat_at,count(s.id)::int AS sessions FROM runners r LEFT JOIN wa_sessions s ON s.runner_id=r.id AND s.closed_at IS NULL GROUP BY r.id ORDER BY r.id`);
 const {rows:outbox}=await pool.query('SELECT state,count(*)::int FROM outbox GROUP BY state');
 const {rows:deliveries}=await pool.query('SELECT state,count(*)::int FROM deliveries GROUP BY state');
 await mkdir('docs/verification',{recursive:true});await writeFile('docs/verification/capacity-latest.json',JSON.stringify({measuredAt:new Date().toISOString(),target:[50,500],targetVerified:false,method:'Fotografia SQL; non è un test di carico',runners,outbox,deliveries,latency:'N/D',cpu:'N/D',memory:'N/D',realDeviceButtons:'Non verificati'},null,2)+'\n');console.log('Fotografia operativa salvata; capacità obiettivo non dichiarata verificata.');
}finally{await pool.end();}
