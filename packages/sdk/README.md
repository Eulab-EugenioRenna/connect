## Facciata applicativa 0.10.0

`@eulab/connect/application` esporta `ConnectApplication` e lo store PostgreSQL condiviso. Una sola istanza governa discovery, migrazione/attivazione, recupero password, OIDC/PKCE, cookie/handoff, sessioni cifrate e rinnovi concorrenti. I metodi 0.9.0 restano compatibili.

Guida completa: [INTEGRATION.md](./INTEGRATION.md). Applicazione BFF indipendente pronta da eseguire: [Workshop](./examples/workshop/README.md). Migrazione store: `migrations/001-application-store.sql`. Il server Connect deve avere schema 013 per le credenziali tecniche prima dell’integrazione (012 per il recupero password). Una sola facciata permette richiesta senza sorgente approvata o client OIDC, attesa senza sessione e sincronizzazione cifrata della configurazione dopo approvazione. Nessuna pubblicazione automatica.

# EULab Connect SDK

SDK ESM per SSO, permessi, utenti e WhatsApp tramite EULab Connect. Richiede un'installazione Connect configurata; il server SDK richiede Node.js 22 o successivo.

```sh
npm install @eulab/connect
```

```ts
import {ConnectBrowser} from '@eulab/connect/browser';

// Mantieni un'istanza condivisa nel service dell'applicazione.
const connect = new ConnectBrowser({
  apiUrl: 'https://auth.eulab.cloud',
  issuer: 'https://auth.eulab.cloud/sso/realms/eulab',
  clientId: 'client-id-della-tua-app',
  redirectUri: 'https://app.example/callback',
  installationId: 'id-installazione',
});
await connect.init({loginRequired: true});
```

L'entrypoint server espone `ConnectServer` e `verifyWebhook`:

```ts
import {ConnectServer, verifyWebhook} from '@eulab/connect/server';
```

Gli export browser e server includono le dichiarazioni TypeScript. Il pacchetto contiene solo JavaScript compilato, tipi e questo README; non contiene credenziali o profili WhatsApp. I segreti dell’installazione devono rimanere sul backend. Il backend deve verificare licenza e permessi per ogni operazione.

`ConnectServer.mirrorUser()` collega un utente locale a Connect. Il campo opzionale `initialPassword` proviene da una verifica locale appena conclusa, serve solo a inizializzare una nuova identità nel provider e non viene conservato da Connect. Non è disponibile nell’SDK browser.

`ConnectOnboardingSource` (server, dalla versione 0.9.0) è il client backend del contratto di attivazione assistita. Richiede la credenziale bootstrap della sorgente, registrata da EULAB prima dell’app/installazione, e non deve essere usato nel browser:

```ts
import {ConnectOnboardingSource} from '@eulab/connect/server';
const onboarding = new ConnectOnboardingSource({
  apiUrl: 'https://auth.eulab.cloud',
  sourceId: 'alora-produzione',
  appId: 'alora',
  secret: process.env.CONNECT_BOOTSTRAP_SECRET!,
});
const lookup = await onboarding.loginContext('persona@example.test');
if (lookup.status === 'not_found') {
  const receipt = await onboarding.submit({
    kind: 'migration',
    consentVersion: '2026-10-21-mandatory-v1',
    localTenant: {id: 'tenant-1', name: 'Azienda', slug: 'azienda'},
    localUser: {id: 'user-1', email: 'persona@example.test', firstName: 'Nome', lastName: 'Cognome', role: 'owner', permissions: []},
    initialPassword: passwordVerifiedLocally,
  }, idempotencyKey);
}
```

`loginContext` non autentica l’utente e restituisce un contesto solo per collegamenti espliciti autorizzati alla sorgente. `submit` accetta `Idempotency-Key` stabili: la stessa chiave con lo stesso body restituisce la pratica esistente, con un body diverso produce un errore 409 e non sostituisce la credenziale. `ConnectOnboardingError.status` conserva il codice HTTP (401/403/409/...) per la gestione consumer. La password transitoria non viene mai restituita, registrata o inclusa nei tipi di risposta.

Le API `/v1/team` sono esposte da `teamOverview`, `teamUsers`, `teamRoles`, `teamFunctions`, `createTeamRole`, `updateTeamRole`, `deleteTeamRole`, `setTeamUserRoles`, `revokeTeamUser` e `restoreTeamUser`. Cliente e applicazione derivano dall’installazione autenticata; ogni assegnazione resta limitata a funzioni attive, licenziate e presenti nella delega del chiamante. Le operazioni di modifica richiedono `team.manage` nella delega effettiva.
