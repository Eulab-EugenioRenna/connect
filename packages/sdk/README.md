### Novità 0.12.0

- Prima versione stabile della linea 0.12 (contenuto della 0.12.0-rc.2 provata in ALORA).
- Client browser: le risposte non JSON dei proxy (502/503/504) diventano messaggi chiari invece di errori di parsing.

## Automazioni server 0.12.0

Delega revocabile, invio/stato e ritiro idempotente del singolo comando sulla stessa outbox, webhook recuperabili: [contratto API/SDK](./AUTOMATIONS.md). Richiede schema Connect 015; candidato locale, non pubblicato. Le credenziali restano nel backend; le API manuali e bot esistenti restano disponibili.

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

Collegamento WhatsApp (dalla versione 0.13.0): `whatsapp.connect()` mostra il QR come prima; `whatsapp.connect({phone: '+39 333 1234567'})` collega con il numero di telefono. In quel caso `whatsapp.qr(id)` restituisce `linkCode` (8 caratteri) e `qr: null`: sul telefono si apre WhatsApp › Dispositivi collegati › Collega un dispositivo › «Collega con il numero di telefono» e si digita il codice. Per cambiare modalità si chiude la sessione in attesa e se ne apre una nuova.

Invio verificato (dalla versione 0.14.0): ogni messaggio è «inviato» solo quando compare sul telefono e WhatsApp lo accetta (ack ≥ 1). Se non compare, Connect lo riprova da solo fino a 6 volte (20 s, 1, 2, 5, 10 minuti): `outbox()` mostra `state: 'queued'`, `attempts` e `error` che inizia con `retrying:`. Esiti finali: `sent`; `failed` con `not_on_whatsapp` (numero senza WhatsApp, nessun tentativo), `not_sent: …` (non partito dopo 6 tentativi) o `provider_rejected`; `uncertain` solo se il messaggio è sul telefono senza conferma: Connect lo ricontrolla da solo e può diventare `sent`. `whatsapp.outboxItem(outboxId)` legge un singolo messaggio; `whatsapp.cancelMessage(outboxId)` annulla un messaggio non ancora partito (anche tra un tentativo e l'altro) e restituisce lo stato aggiornato.

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

### Candidata 0.11.0: creazione account delegata

La facciata server espone `application.team.createUser(sessionId, {localUser, roleIds, initialPassword?})`. Il consumer fornisce un profilo con ID locale già persistito; lo SDK ricava sorgente/azienda dalla sessione e configura il mirror completo senza esporre credenziali nel browser. Servono API aggiornata, migrazione 014, bootstrap provider e `team.manage` effettivo. Errori di business tipizzati conservano la sessione; esiti incerti richiedono verifica e azione esplicita sullo stesso ID. Vedi `INTEGRATION.md` e la consegna `docs/DELEGATED-ACCOUNTS-STEP-5.md` nel repository. Il metodo non è disponibile nella distribuzione 0.10.0.

Storico WhatsApp (dalla versione 0.14.0): uno per licenza e numero, senza doppioni. Il primo collegamento di un numero legge tutta la cronologia (`sync_mode: 'full'`); ricollegare lo stesso numero, anche dopo averne usato un altro, aggiunge solo i messaggi nuovi (`sync_mode: 'update'`). `deleteConnection` scollega il numero e conserva lo storico; `deleteArchive` non esiste più: lo storico si elimina solo eliminando la licenza (installazione).
