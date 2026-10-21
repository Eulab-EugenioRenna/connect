import { createHash, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { required } from './config.js';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function seal(value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(required('DATA_ENCRYPTION_KEY'),'hex'), iv);
  const data = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function unseal(value: string): string {
  const data = Buffer.from(value,'base64'), cipher = createDecipheriv('aes-256-gcm',Buffer.from(required('DATA_ENCRYPTION_KEY'),'hex'),data.subarray(0,12));
  cipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');
}
export function signature(secret: string, timestamp: string, body: string): string { return createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex'); }
export function verifySignature(secret: string, timestamp: string, body: string, received: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(signature(secret,timestamp,body),'hex'),Buffer.from(received,'hex'));
}
