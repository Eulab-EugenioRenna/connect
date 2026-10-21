import {Injectable} from '@nestjs/common';
import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
export function isPublicCatalogAddress(address:string){
 if(net.isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224||a===198&&(b===18||b===19)||a===192&&b===0);
}
@Injectable()
export class CatalogReader {
 async read(value:string):Promise<unknown>{
  const source=new URL(value);if(source.username||source.password||source.hash)throw new Error('URL matrice non valido');
  const mapping=JSON.parse(process.env.CATALOG_INTERNAL_ORIGINS_JSON||'{}') as Record<string,string>;
  const configured=mapping[source.origin];
  const target=configured?new URL(source.pathname+source.search,new URL(configured)):source;
  if(configured){const origin=new URL(configured);if(origin.href!==origin.origin+'/'||!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw new Error('Mapping locale catalogo non valido');}
  else if(source.protocol!=='https:'||source.port&&source.port!=='443')throw new Error('La matrice richiede HTTPS');
  const addresses=await lookup(target.hostname,{all:true});
  if(!addresses.length||(!configured&&addresses.some(a=>!isPublicCatalogAddress(a.address))))throw new Error('Destinazione catalogo non consentita');
  const selected=addresses.find(a=>net.isIP(a.address)===4);if(!selected)throw new Error('Destinazione catalogo non supportata');
  return new Promise((resolve,reject)=>{
   const request=(target.protocol==='https:'?https:http).request(target,{method:'GET',timeout:5000,family:4,lookup:(_host,_options,cb)=>cb(null,selected.address,4),headers:{Accept:'application/json'}},response=>{
    if(response.statusCode!==200){response.resume();reject(new Error('GET matrice: HTTP '+response.statusCode));return;}
    if(!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers['content-type']||'')){response.resume();reject(new Error('La matrice deve essere JSON'));return;}
    const chunks:Buffer[]=[];let size=0;response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1048576){request.destroy(new Error('Matrice troppo grande'));return;}chunks.push(chunk);});
    response.on('error',reject);response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('JSON matrice non valido'));}});
   });request.on('timeout',()=>request.destroy(new Error('Timeout GET matrice')));request.on('error',reject);request.end();
  });
 }
}
