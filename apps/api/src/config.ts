export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Configurazione obbligatoria: ${name}`);
  return value;
}
export const redisOptions = () => {
  const url = new URL(required('REDIS_URL'));
  return { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, maxRetriesPerRequest: null };
};
