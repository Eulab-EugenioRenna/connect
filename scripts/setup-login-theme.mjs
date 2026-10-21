// Update only presentation settings on the existing realm. Never reimport or reset users.
process.loadEnvFile('.env');
const origin = process.env.QA_KEYCLOAK_URL || process.env.PUBLIC_KEYCLOAK_URL || 'http://localhost:8080';
const tokenResponse = await fetch(`${origin}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'password', client_id: 'admin-cli',
    username: process.env.KEYCLOAK_ADMIN || 'eulab-operator',
    password: process.env.KEYCLOAK_ADMIN_PASSWORD,
  }),
});
if (!tokenResponse.ok) throw new Error(`Autenticazione amministrativa Keycloak: ${tokenResponse.status}`);
const {access_token} = await tokenResponse.json();
const response = await fetch(`${origin}/admin/realms/eulab`, {
  method: 'PUT',
  headers: {'content-type': 'application/json', authorization: `Bearer ${access_token}`},
  body: JSON.stringify({loginTheme: 'eulab', displayName: 'EULab', internationalizationEnabled: true, supportedLocales: ['it', 'en'], defaultLocale: 'it'}),
});
if (!response.ok) throw new Error(`Attivazione tema EULab: ${response.status}`);
console.log('Tema login EULab attivato sul realm eulab. Utenti e credenziali conservati.');
