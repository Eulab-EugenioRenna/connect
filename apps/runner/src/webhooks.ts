import { lookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { signature,unseal } from '../../api/src/security.js';
export function publicAddress(address:string):boolean {
 if(net.isIP(address)!==4)return false; // Fail closed for IPv6 until an IPv6 egress policy is deployed.
 const [a,b]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224||a===198&&(b===18||b===19)||a===192&&b===0);
}
export async function deliver(urlValue:string,cipher:string,event:unknown,id:string):Promise<number>{
 const url=new URL(urlValue);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('WEBHOOK_URL_REJECTED');
 const addresses=await lookup(url.hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('WEBHOOK_PRIVATE_ADDRESS');
 const address=addresses[0].address,body=JSON.stringify(event),timestamp=String(Math.floor(Date.now()/1000));
 return new Promise((resolve,reject)=>{
   const req=https.request(url,{method:'POST',timeout:10000,lookup:(_host,_opts,cb)=>cb(null,address,4),headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-eulab-event-id':id,'x-eulab-timestamp':timestamp,'x-eulab-signature':signature(unseal(cipher),timestamp,body)}},res=>{res.resume();resolve(res.statusCode||0);});
   req.on('timeout',()=>req.destroy(new Error('WEBHOOK_TIMEOUT')));req.on('error',reject);req.end(body);
 });
}

/** The same stable envelope is signed on every delivery attempt. */
export function webhookEnvelope(e:{id:string;kind:string;created_at:Date|string;installation_id:string;session_id:string;payload:unknown}){
 return {id:e.id,kind:e.kind,createdAt:e.created_at,installationId:e.installation_id,sessionId:e.session_id,payload:e.payload};
}
