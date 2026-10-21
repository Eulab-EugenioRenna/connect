# MFA, SMTP, dispositivi attendibili e notifiche

## Stato della modifica

API e web **applicati allo stack locale**; SMTP verificato e sincronizzato. Il nuovo provider/flusso MFA **non è installato e attivato nel Keycloak in esecuzione**. L’SDK locale è 0.7.1. API, SDK e interfacce passano la compilazione TypeScript/build Vite. Le verifiche HTTP usano PostgreSQL PGlite e un provider OIDC simulato; non dimostrano l’autenticazione MFA su Keycloak reale. Il provider Java è predisposto per Keycloak **26.3.3**: la compilazione completa delle classi contro le librerie reali e il nucleo Java OTP sono verificati. Packaging Maven e collaudo end-to-end MFA restano da completare. [Controllo corrente e limiti](CHECK-GLOBALE-2026-10-19.md).

Nel sandbox di questa sessione Docker non è accessibile, l’apertura del server Vite è vietata (`listen EPERM`), Chromium non si avvia (`MachPortRendezvous`) e il repository Maven non è risolvibile. Non sono state applicate migrazioni al database attivo, attivati flussi, modificati account o inviati messaggi reali.

## Comportamento

- Primo accesso su un browser: password, poi codice dell’app Authenticator oppure codice email. MFA rimane interna a Keycloak: le applicazioni ricevono soltanto il normale callback OIDC.
- Codice email: 6 cifre casuali, validità 5 minuti, massimo 5 tentativi complessivi nel flusso e 3 invii distanziati di almeno 60 secondi. Il nuovo invio invalida il precedente. Il codice viene conservato come hash nella sessione di autenticazione, mai stampato. L’indirizzo deve essere verificato e non può essere scelto dal form.
- App Authenticator: configurazione con QR e conferma del primo codice mediante l’azione nativa `CONFIGURE_TOTP`. Se una persona non ha né app configurata né email verificata utilizzabile, il login richiede la configurazione nativa dell’app prima di rilasciare la sessione.
- Dopo una verifica MFA riuscita l’utente può scegliere **Considera attendibile questo dispositivo per 30 giorni**. Cookie HttpOnly, Secure e SameSite=Lax, limitato al percorso del realm; token casuale di 256 bit, solo hash salvato nelle credenziali della persona in Keycloak. Massimo 20 dispositivi per identità. La fiducia non è abilitata su HTTP, incluso localhost.
- Gli accessi successivi riconoscono il dispositivo dopo la password e saltano MFA fino alla scadenza della fiducia. Una sessione SSO già attiva consente il passaggio fra applicazioni senza ripetere il login. La scadenza della fiducia si applica alla successiva autenticazione; la sessione ha i propri timeout.
- **Ricordami** gestisce la persistenza della sessione SSO ed è distinto dalla fiducia del dispositivo. Valori iniziali all’attivazione: 7 giorni di inattività, massimo 30 giorni. Modificabili da Impostazioni accesso.
- La revoca del proprio dispositivo elimina la credenziale e richiede la chiusura di tutte le sessioni SSO della persona. Se la chiusura fallisce, il risultato segnala `sessionsLoggedOut:false`: la fiducia è già revocata e il pannello permette di riprovare la chiusura delle sessioni. Quando la chiusura riesce l’SDK browser cancella la sessione locale; gli altri client devono rispettare le revoche backend già previste.
- Email non disponibile/errore SMTP: nessuna autenticazione concessa tramite email. Se l’app è già configurata si può usarla; la configurazione iniziale dell’app copre gli account senza email utilizzabile.

Il flusso mantiene il cookie SSO nativo come alternativa al percorso password + MFA. Le sessioni esistenti al momento dell’attivazione continuano fino alla loro scadenza/revoca. Per imporre subito la nuova verifica a una persona, chiudere le sue sessioni dal pannello Sessioni attive. Il bootstrap amministrativo del master realm rimane separato.

## SMTP e attivazione

Impostare sul server, nel file ambiente locale usato dallo stack, `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD` e `SMTP_SECURITY`. I valori segreti non vanno inseriti nel repository o nella documentazione. `SMTP_SECURITY` ammette `starttls` (normalmente porta 587, TLS obbligatorio) o `tls` (normalmente 465). I certificati sono verificati. L’API legge le credenziali dall’ambiente; l’azione amministrativa di sincronizzazione configura il trasporto email gestito da Keycloak per OTP, verifica email e recupero password. Le risposte API e l’audit non restituiscono credenziali.

Per lo stack locale già configurato:

```sh
# Compila anche il provider e ricrea solo Keycloak, API e web; conserva i volumi.
docker compose build keycloak api web
docker compose run --rm migrate
docker compose up -d --no-deps keycloak api web
```

Dopo l’avvio, da **Impostazioni accesso → Email SMTP**, eseguire **Sincronizza SMTP con SSO**. Il pulsante invoca `POST /v1/security/smtp/sync`, riservato agli amministratori. Servono il servizio di gestione identità e i ruoli configurati da `scripts/setup-admin.mjs`.

```sh
# Crea e ispeziona il flusso senza selezionarlo per il login.
node scripts/setup-security.mjs

# Seleziona il flusso verificato per i nuovi accessi.
node scripts/setup-security.mjs --activate
```

Lo script usa `EULAB_ENV_FILE` (default `.env`) e `KEYCLOAK_INTERNAL_URL`, oppure `PUBLIC_KEYCLOAK_URL`. Questi URL devono includere `/sso` quando il provider è pubblicato con quel prefisso. Richiede il provider installato e SMTP configurato; conserva account e password. È ripetibile e lega il realm al nuovo flusso soltanto dopo averne verificato struttura e ordine. In presenza di flussi browser personalizzati, identity provider esterni, password grant attivi o override browser sui client, interrompe la configurazione per non eliminare o aggirare percorsi esistenti.

Per produzione usare gli stessi overlay e il file ambiente documentati in [PRODUZIONE.md](PRODUZIONE.md). L’immagine `Dockerfile.production` include il provider prima di `kc.sh build`. Non reimportare o ricreare il realm per attivare MFA. Il ripristino del solo binding può avvenire dalla console master scegliendo l’alias precedente, salvato nell’attributo realm `eulab.previousBrowserFlow`; credenziali e dati restano conservati.

## Notifiche personali e email

In **Notifiche**: elenco paginato, totale non lette, filtro, lettura/non lettura e “Segna tutte come lette”. La campanella aggiorna il totale ogni 30 secondi. Le notifiche sono personali, associate al subject SSO e disponibili nelle app collegate via SDK. Non vengono generate automaticamente nuove comunicazioni per eventi non richiesti.

L’amministratore può creare una notifica e scegliere l’invio email al destinatario verificato. La creazione richiede `Idempotency-Key`. Riutilizzare la stessa chiave con lo stesso contenuto restituisce il record esistente senza inviare nuovamente; un contenuto diverso restituisce 409. L’esito SMTP è separato dalla lettura della notifica:

| Stato email | Significato |
| --- | --- |
| `not_requested` | Notifica solo nell’app |
| `sending` | Invio riservato/in corso; dopo un arresto il risultato può restare sconosciuto |
| `accepted` | Server SMTP ha accettato il messaggio; non prova consegna o lettura |
| `failed` | Invio rifiutato o fallito prima della trasmissione confermabile |
| `uncertain` | Esito non confermato, ad esempio timeout dopo DATA |

Non sono previsti reinvii automatici. Un nuovo invio intenzionale dopo un esito incerto richiede una decisione esplicita e una nuova chiave. La lettura/non lettura riguarda esclusivamente l’elenco nell’app, senza pixel di tracciamento email.

| Endpoint | Accesso |
| --- | --- |
| `GET /v1/notifications?unread=true&limit=30` | Elenco personale; cursore `before` + `beforeId` |
| `PUT /v1/notifications/:id/read` con `{read:true/false}` | Solo destinatario |
| `POST /v1/notifications/read-all` | Solo elenco personale |
| `POST /v1/notifications` con `{subject,title,body,email}` | Admin + Idempotency-Key |
| `GET /v1/security/me` | MFA e dispositivi propri, senza segreti |
| `DELETE /v1/security/devices/:id` | Solo dispositivo proprio; termina le proprie sessioni |
| `GET /v1/security/settings` | Admin |
| `PUT /v1/security/remember-me` | Admin |
| `POST /v1/security/smtp/sync` | Admin |

## Login app → SSO → app con SDK 0.7.1

Il callback deve essere registrato nel client Keycloak per l’app e deve restituire la stessa pagina che inizializza l’SDK. Per le nuove integrazioni registrare callback esatti, PKCE S256 e audience `connect-api`. Il ritorno a una pagina dell’app è conservato nella scheda e non può puntare a un’altra origine.

```ts
import {ConnectBrowser} from '@eulab/connect/browser';

const sdk = new ConnectBrowser({
  apiUrl: connectApiUrl,
  issuer: connectIssuer,
  clientId: oidcClientId,
  installationId,
  redirectUri: location.origin + '/login/callback',
});

// Sul pulsante Accedi dell’app:
await sdk.login({returnTo: '/ordini/42'});

// All’avvio dell’app, inclusa la pagina /login/callback:
const result = await sdk.loginResult();
if (result.status === 'authenticated') {
  // history è già tornata alla destinazione interna richiesta.
  // Montare la rotta nell’eventuale router dell’app.
  renderAuthenticatedApp(result.access);
} else if (result.status === 'error') {
  renderLoginError(result.code, result.message);
} else {
  renderLoginButton();
}
```

`loginResult()` scambia il codice e verifica anche `canLogin` quando è presente `installationId`: un login SSO riuscito può comunque produrre errore applicativo per licenza, appartenenza o collegamento mancanti. Il backend dell’app continua a verificare token e autorizzazioni; un risultato positivo del browser non sostituisce questi controlli.

I codici callback sono monouso; lo state è obbligatorio anche sugli errori, la richiesta scade dopo 10 minuti, l’eventuale issuer restituito deve corrispondere e i parametri OAuth sono rimossi dall’URL anche in caso di errore. Nessun token viene aggiunto all’URL di ritorno. Sono disponibili `prompt: 'none'` per tentare la sessione SSO esistente e `prompt: 'login'`/`maxAge` per richiedere una nuova autenticazione. Non conservare token applicativi oltre la sessione revocata.

```ts
await sdk.configureMfa(); // SSO nativo: QR + conferma codice, poi callback app
await sdk.verifyEmail();
const security = await sdk.accountSecurity();
await sdk.revokeTrustedDevice(deviceId); // cancella anche la sessione SDK locale
const notifications = await sdk.notifications({unread: true});
await sdk.markNotification(notificationId, true);
await sdk.markAllNotificationsRead();
```

`actionStatus` nel risultato positivo segnala il ritorno di un’azione richiesta; il suo successo non dimostra da solo che una credenziale sia presente. Rileggere `accountSecurity()` per mostrare lo stato reale. Le API precedenti `login()`, `callback()` e `init()` restano disponibili. I callback pendenti generati con SDK antecedenti al nuovo formato devono essere riavviati.

Anche l’SDK server espone lettura/aggiornamento delle notifiche e gestione dei propri dispositivi, richiedendo il bearer dell’utente oltre al segreto installazione. Il login locale e i dati delle app esistenti restano invariati.

## Verifiche prima dell’utilizzo reale

Risultato della sessione iniziale (superato dal [controllo globale corrente](CHECK-GLOBALE-2026-10-19.md)): **44 test, 43 passati, 0 falliti, 1 saltato** per socket vietato dal sandbox. Build TypeScript/Vite, nucleo Java OTP e validazione Compose locale/produzione superati. [Evidenze della sessione](verification/security/result.json).

```sh
npm test
npm run build
npm run test:mfa:core # richiede JDK 21
npm run infra:check
```

In un ambiente con Docker e accesso a Maven, compilare l’immagine Keycloak e verificare poi, con account di prova e destinatario autorizzato: QR e conferma TOTP, codice email corretto/errato/scaduto, limite tentativi e resend, annullamento verso l’app, primo dispositivo, successivo accesso trusted su HTTPS, revoca e nuovo MFA, scadenze SSO, callback app autorizzato e accesso app negato. Controllare anche desktop/mobile delle nuove pagine e i template serviti da Keycloak. Questi controlli restano **non eseguiti** nella sessione locale corrente.

Riferimenti di implementazione: [SPI Keycloak](https://github.com/keycloak/keycloak/blob/26.3.3/services/src/main/java/org/keycloak/authentication/authenticators/browser/OTPFormAuthenticator.java), [gestione credenziali Keycloak](https://github.com/keycloak/keycloak/blob/26.3.3/services/src/main/java/org/keycloak/services/resources/admin/UserResource.java), [SMTP Nodemailer](https://nodemailer.com/smtp).

L’incremento storico SDK 0.5.1 ha aggiunto check con rinnovo a ogni controllo e inizializzazione condivisa per service: [dettagli](INTEGRAZIONI.md#inizializzazione-in-un-service-condiviso). [Verifica locale aggiornata](verification/token-refresh/result.json).


## Gestione per utente e preferenze SDK

La gestione amministrativa è in **Utenti e accessi → Sicurezza e preferenze**. La voce generale **Impostazioni accesso** gestisce durata SSO e sincronizzazione SMTP. La persona configura app Authenticator e verifica email dal login SSO aperto dall’SDK.

```ts
await sdk.configureMfa();
await sdk.verifyEmail();
const security = await sdk.accountSecurity();
await sdk.setMfaPreference('email'); // auto | totp | email
```

Eseguire `npm run security:profile` sul realm esistente prima di usare le preferenze (incluso anche nel comando CLI di preparazione MFA). Dichiara il solo campo, modificabile in Keycloak soltanto dagli amministratori; le app usano l’API autenticata per il proprio subject.

La preferenza è salvata nell’attributo Keycloak `eulab.mfa.preferredMethod`, letto dal provider MFA al prossimo login. Se il metodo scelto non è utilizzabile, il provider propone un metodo valido o richiede la configurazione dell’app. La preferenza non salta MFA e non invia automaticamente codici email.

Le funzioni amministrative SDK `userSecurity(subject)`, `setUserMfaPreference(subject, method)` e `revokeUserCredential(subject, id)` richiedono il ruolo admin. Le risposte includono soltanto metadati pubblici delle app/dispositivi, mai seed OTP, hash o password. La rimozione di un’app elimina anche i dispositivi attendibili e tenta il logout SSO; `sessionsLoggedOut=false` segnala di completare la disconnessione dal pannello Sessioni attive. `trustedDevicesRevoked=false` segnala una pulizia parziale dei dispositivi, da completare con le revoche individuali. Gli account di servizio e le credenziali password non sono modificabili da questi endpoint.

| Endpoint aggiuntivo | Accesso |
| --- | --- |
| `PUT /v1/security/me/preferences` | Preferenza della propria identità |
| `GET /v1/security/users/:subject` | Admin |
| `PUT /v1/security/users/:subject/preferences` | Admin |
| `DELETE /v1/security/users/:subject/credentials/:id` | Admin; solo OTP e dispositivi attendibili |

[Ambienti e comandi aggiornati](AMBIENTI-E-COMANDI.md).
