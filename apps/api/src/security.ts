import { createHash, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { required } from './config.js';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function equalSecret(received: string, expectedHash: string): boolean {
  const left = Buffer.from(hash(received),'hex'), right = Buffer.from(expectedHash,'hex');
  return left.length === right.length && timingSafeEqual(left,right);
}
// Il formato storico senza AAD resta quello di seal/unseal, così i segreti già
// conservati continuano a essere leggibili dopo l'aggiornamento.
function sealWithKey(value: string, keyHex: string, aad?: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex,'hex'), iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
function unsealWithKey(value: string, keyHex: string, aad?: string): string {
  const data = Buffer.from(value,'base64');
  if (data.length < 29) throw new Error('CREDENZIALE_CIFRATA_NON_VALIDA');
  const cipher = createDecipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),data.subarray(0,12));
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');
}
export function seal(value: string): string {
  return sealWithKey(value, required('DATA_ENCRYPTION_KEY'));
}
export function unseal(value: string): string {
  return unsealWithKey(value, required('DATA_ENCRYPTION_KEY'));
}
// Chiave separata, letta soltanto dal servizio di esecuzione della migrazione.
function migrationKey(): string {
  const key=required('MIGRATION_ENCRYPTION_KEY');
  if(!/^[a-f0-9]{64}$/i.test(key))throw new Error('MIGRATION_ENCRYPTION_KEY non valida: servono 64 caratteri esadecimali');
  return key;
}
export function sealMigrationValue(value: string, aad: string): string {
  return sealWithKey(value, migrationKey(), 'eulab-connect:onboarding:'+aad);
}
export function unsealMigrationValue(value: string, aad: string): string {
  return unsealWithKey(value, migrationKey(), 'eulab-connect:onboarding:'+aad);
}
export function signature(secret: string, timestamp: string, body: string): string { return createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex'); }
export function verifySignature(secret: string, timestamp: string, body: string, received: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(signature(secret,timestamp,body),'hex'),Buffer.from(received,'hex'));
}
