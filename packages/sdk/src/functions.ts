export const functionCatalogPath='/.well-known/eulab-connect.json';
export interface AppFunction {key:string;name:string;description?:string}
export interface FunctionMatrix {schemaVersion:1;appId:string;version:number;functions:AppFunction[]}
export interface AccessResult {installationId:string;appId:string|null;subject:string|null;localUserId:string|null;canLogin:boolean;reason:string;functions:AppFunction[];catalogVersion:number;functionsStatus:'pending'|'last_valid'|'ready'}
export interface ConnectUser {subject:string;localUserId:string;displayName:string;roles:{id:string;name:string}[]}
export function defineFunctions(input:Omit<FunctionMatrix,'schemaVersion'>):FunctionMatrix{
 const validKey=(key:string)=>/^[a-z][a-z0-9_.:-]{0,79}$/.test(key);
 if(!validKey(input.appId)||!Number.isSafeInteger(input.version)||input.version<1||input.functions.length>200||new Set(input.functions.map(f=>f.key)).size!==input.functions.length||input.functions.some(f=>!validKey(f.key)||!f.name.trim()||f.name.length>200||(f.description?.length||0)>1000))throw new Error('Matrice funzioni non valida');
 return {schemaVersion:1,appId:input.appId,version:input.version,functions:input.functions.map(f=>({...f}))};
}
export function functionsResponse(matrix:FunctionMatrix):Response{return Response.json(defineFunctions(matrix),{headers:{'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});}
