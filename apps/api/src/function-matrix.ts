import {z} from 'zod';
import {key,name} from './validation.js';
export const functionMatrixSchema=z.object({schemaVersion:z.literal(1),appId:key,version:z.number().int().positive(),functions:z.array(z.object({key,name,description:z.string().max(1000).optional()}).strict()).max(200)}).strict().refine(v=>new Set(v.functions.map(f=>f.key)).size===v.functions.length,'Funzioni duplicate');
export function defaultCatalogUrl(installation:{domain:string;basePath?:string;base_path?:string;integration:string}){return installation.domain+(installation.basePath??installation.base_path??'')+(installation.integration==='wordpress'?'/index.php?eulab_catalog=1':'/.well-known/eulab-connect.json');}
