# Integrazione server Connect SDK 0.10.0

Nuova esportazione `@eulab/connect/application`, indipendente da Nest/Angular. `ConnectServer`, `ConnectBrowser`, `ConnectOnboardingSource` e le API `/v1/team` della 0.9.0 restano disponibili. Il nuovo modulo compone questi servizi e OIDC; nessuna dipendenza da Prisma, ALORA, profili aziendali o browser storage. Node >=22, dipendenza runtime `jose`; per lo store pronto installare `pg`.

## Installazione e prerequisiti

```sh
npm install /percorso/eulab-connect-0.10.0.tgz pg
```

Per presentare la prima pratica **non servono applicazione, sorgente approvata, licenza o client OIDC**. Un amministratore Connect emette una credenziale tecnica da **Attivazioni e migrazioni**, oppure `POST /v1/onboarding/presenters`: nome, deploymentIdentity stabile, scadenza; origini/app verificate sono attestazioni amministrative opzionali. Consegnare ID e segreto una sola volta al backend consumer mediante il proprio secret manager. Non usare credenziali Admin EULAB nel consumer.

La prima discovery/invio autenticata riserva `sourceId` al deployment e registra soltanto la provenienza non approvata. Non crea app, aziende, installazioni, identità, licenze o sessioni. Un altro presenter non può assumere un sourceId riservato; ruotare il segreto dello stesso presenter conserva il vincolo. Revoca/scadenza bloccano anche il recupero della configurazione.

Sul server Connect applicare le migrazioni fino a **013-onboarding-presenters.sql** tramite il normale comando amministrativo `npm run db:migrate`, dopo revisione/backup. Non applicarle nel database consumer. La candidata non esegue questo aggiornamento operativo automaticamente.

Nel consumer preparare PostgreSQL condiviso, chiave AES-256 casuale di 64 cifre esadecimali e namespace stabile distinto per sorgente/app/ambiente. Eseguire `store.migrate()` o `migrations/001-application-store.sql` nel database consumer. Conservare chiave e credenziali solo sul backend.

Il percorso precedente resta compatibile: `POST /v1/connect-sources` registra una sorgente con segreto backend; issuer/clientId/redirectUri possono essere forniti staticamente. Le sorgenti esistenti restano approvate per compatibilità: nessuna conversione automatica in presenter.

HTTP è rifiutato salvo `allowLoopbackHttp: true` e host `localhost`, `127.0.0.1` o `[::1]`. Configurare HTTPS in ambienti condivisi. Non usare il bypass HTTP per domini privati o reti Docker. URL senza password, frammenti o credenziali. Usare issuer canonico senza slash finale.

## Una sola istanza

```ts
import {ConnectApplication, PostgresConnectApplicationStore} from '@eulab/connect/application';
import {defineFunctions} from '@eulab/connect/server';
import pg from 'pg';

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const store = new PostgresConnectApplicationStore(pool, 'my-app:development:source-1');
const connect = new ConnectApplication({
  apiUrl, sourceId, appId, sourceSecret,
  issuer, clientId, clientSecret, redirectUri, appOrigin,
  encryptionKey, store,
  catalog: defineFunctions({appId, version: 1, functions}),
  accounts: {verifyLegacy, provision, restrict},
});
```

Per partire prima dell’integrazione, usare lo stesso costruttore senza `sourceSecret`, `issuer`, `clientId`, `clientSecret` e `redirectUri`, aggiungendo:

```ts
presenter: {
  id: process.env.CONNECT_PRESENTER_ID,
  secret: process.env.CONNECT_PRESENTER_SECRET,
  deployment: {
    name: 'Workshop sviluppo', environment: 'development',
    origins: [appOrigin], catalogUrl: appOrigin + '/.well-known/eulab-connect.json',
    oidcCallbacks: [appOrigin + '/callback'],
  },
},
```

I metadati dichiarati non provano proprietà di app, email o URL. L’app verificata univoca può preselezionare il piano, senza concedere accesso. L’amministratore seleziona/crea app, cliente e installazione nella stessa pratica, assegna licenza/ruoli e collega esplicitamente eventuali identità esistenti, poi usa **Esegui migrazione**. Per nuovi presenter `prepare` verifica il piano senza creare oggetti. Password e permessi locali non diventano concessioni automatiche.

Prima di completare il piano, registrare nel provider il client Authorization Code/PKCE S256, callback esatta e audience `connect-api`; non abilitare password grant nel consumer. L’amministratore salva issuer/clientId/redirectUri ed eventuale segreto confidential nel piano, separatamente cifrato. Il segreto non torna nel JSON del piano o nell’audit. La configurazione diventa disponibile solo dopo completamento.

Il backend esegue `await connect.configuration.sync()` tramite un job o handler POST con Origin verificato; la risposta pubblicabile contiene solo stato e appId. `POST /v1/app-onboarding/configuration` richiede il medesimo presenter e segreto, non il solo deploymentId. La facciata valida origine callback, cifra la configurazione nello store condiviso e la ricarica al riavvio. Non richiamare il metodo basso livello dal browser: la risposta server include segreti. Non sincronizza automaticamente altri processi già avviati: richiamare sync anche su quelle istanze dopo una modifica amministrativa.

Prima del completamento sync può restituire `plannedAppId`, utile **solo** per pubblicare `connect.catalog` con l’app selezionata se diversa da quella dichiarata. Richiamare sync all’avvio del backend e dopo un cambio piano; questo suggerimento non è persistito né abilita SSO. Servire il catalogo dalla proprietà `connect.catalog`, non ricostruire il protocollo. Pubblicare un catalogo HTTPS raggiungibile dal server Connect prima dell’esecuzione reale.

Le variabili sono lette dalla configurazione backend, mai da un bundle frontend. Lo store è obbligatorio; non esiste un default in memoria. Conservare chiave e namespace identici fra istanze della stessa applicazione. La rotazione della chiave invalida i flussi/sessioni precedenti: pianificare una nuova autenticazione; non è presente un keyring automatico.

## Adattatori dell’applicazione

- `verifyLegacy({email,password}) → LegacyAccount | null`: verifica locale della password, restituisce ID azienda/persona, nome, ruolo e permessi proposti. Nessun hash o segreto nel risultato. Ambiguità fra aziende deve essere rifiutata o risolta nel proprio contesto locale, mai indovinata. Non crea sessioni.
- `provision(context,{operationId,transaction}) → {localTenantId,localUserId}`: eseguito **solo dopo** ID token firmato, issuer/audience/nonce/subject, accesso Connect e collegamenti verificati. Risolve gli ID espliciti autorizzati, preserva password/hash/profili esistenti, rifiuta conflitti. Non cercare un account da collegare tramite email. Per utenti Connect-only creare il profilo operativo senza copiare alcuna password Connect nel database locale.
- `restrict(profile,functionKey,resource) → boolean`: applica isolamento aziendale e restrizioni personali. L’autorizzazione Connect non filtra il database applicativo. Ogni query deve avere anche il proprio predicato sull’azienda autorizzata.
- `ConnectApplicationStore`: persistenza secondo il contratto TypeScript; usare l’adattatore PostgreSQL pronto se non occorre uno store custom. Catalogo funzioni dichiarato una sola volta nella configurazione.

I ruoli locali del contratto sorgente restano quelli pubblici 0.9.0 (`owner`, `manager`, `reception`, `collaborator`); non si sostituisce il modello autorizzativo locale con ruoli inventati dal consumer.

## Handler BFF

Ogni handler costruisce `BrowserContext = {origin,cookies}`. Per POST verificare l’**Origin reale** della richiesta contro `appOrigin`, prima della chiamata SDK. Non riempire `origin` con un valore fisso che aggiri il controllo. Per callback GET usare l’origine della URL effettiva dopo verifica di Host/proxy fidato: state e cookie proteggono il ritorno OIDC. Non fidarsi di Forwarded/Host arbitrari.

Applicare tutte le `CookieDirective` restituite come Set-Cookie: HttpOnly, SameSite=Lax, Secure con HTTPS, Path=/, Max-Age. I cookie HTTPS usano prefisso `__Host-`; non impostare Domain. Non pubblicare `cookies` come JSON sostitutivo dei veri header.

| Handler | Metodo SDK | Risultato UI |
|---|---|---|
| POST login | `auth.signIn({email,password?},ctx)` | `redirect`, `migration_required`, `pending`, `administrative_required` o `configuration_required` |
| POST sincronizza configurazione | `configuration.sync()` | `pending`, `configuration_required` o `ready` (solo metadati sicuri) |
| POST consenso | `migration.submit({challenge,legacyPassword,consentVersion,idempotencyKey,newConnectPassword?},ctx)` | stato/azione della richiesta |
| POST attivazione | `activation.submit({kind:'activation',companyName,applicant,initialPassword,consentVersion,idempotencyKey},ctx)` | stato/azione; nessuna sessione |
| GET callback | `auth.callback({state,code,error,iss},ctx)` | handoff opaco, cookie e redirect interno fisso |
| POST handoff | `auth.exchange(handoff,ctx)` | sessione locale e cookie; nessun token provider |
| Richiesta autenticata | `auth.resolve(auth.fromCookies(ctx))` | profilo verificato, subject, scadenza |
| POST refresh | `auth.refresh(sessionId)` | sessione; mai replay della mutazione applicativa |
| POST logout | `auth.logout(sessionId,ctx)` | `revoked`, `providerRevoked`, cookie eliminato |
| Operazione sui dati | `access.authorize(sessionId,functionKey,resource)` | autorizzazione centrale + restrizione locale |

`sessionId` è il solo handle casuale locale; il BFF può ometterlo dal JSON e conservarlo esclusivamente nel cookie HttpOnly. Non esporre mai `source.loginContext()` o un `ConnectServer` direttamente al browser: sono API backend che includono contesto/credenziali d’installazione. Anche `services()` è una callback **server**.

Usare un redirect interno fisso dopo callback. Se il BFF consegna l’handoff alla UI, usare un fragment, `Referrer-Policy: no-referrer`, niente log di URL/credenziali, rimuovere subito il fragment e inviarlo a `auth.exchange`. Non aggiungere un `returnTo` arbitrario. Il demo include tutti gli handler e una UI minima che rende gli esiti discriminati.

## Discovery, migrazione e stati

`signIn` invoca prima la sorgente Connect. Un collegamento autorizzato conduce direttamente a SSO; la password legacy non viene verificata. Un errore di sorgente o una revoca blocca il flusso, senza fallback legacy operativo.

Un conflitto di provenienza restituisce `administrative_required`; un accesso approvato senza configurazione OIDC restituisce `configuration_required`. Non verificano legacy né creano challenge/sessioni. Una pratica pendente restituisce attesa senza provisioning. Se serve una migrazione/reinvio/nuova password, una prova legacy valida crea un challenge opaco di 120 secondi legato al cookie. `migration.submit` richiede consenso versione `2026-10-21-mandatory-v1`, consuma il challenge una volta e ripete la verifica legacy. Non conserva la password legacy nello store. Un errore dopo il consumo richiede una nuova prova/challenge; non ripetere automaticamente.

Gli endpoint sorgente aggiungono `nextAction` a `{requestId,state}`. Il campo è opzionale nei tipi SDK per interoperabilità con server 0.9; in assenza di azione esplicita, i fallimenti richiedono assistenza (nessuna deduzione da messaggi HTTP).

| `nextAction` | UI e comportamento |
|---|---|
| `wait` | Attesa; aggiornamento tramite nuova discovery esplicita |
| `sign_in` | Nuovo login SSO |
| `choose_connect_password` | Solo migrazione legacy recuperabile: nuova prova locale + consenso + password Connect diversa |
| `resubmit` | Nuova prova e consenso, invio esplicito secondo i vincoli server |
| `contact_admin` | Attivazione con password rifiutata, collegamento esplicito o verifica amministrativa; nessuna prova legacy né merge per email |
| `closed` | Richiesta/pratica chiusa; nessuna riapertura tramite recupero |

Compatibilità: il server conserva il reinvio già supportato di una richiesta personale scaduta, **solo se la pratica aziendale è ancora riutilizzabile**. Le pratiche aziendali `rejected`, `expired`, `completed` e quelle `migrating` non vengono riaperte dal recupero. Una richiesta completata resta completata.

## Recupero password rifiutata

Una policy provider può produrre `failed` / `password_change_required` dopo la cancellazione della credenziale transitoria. La discovery restituisce `choose_connect_password` soltanto per una migrazione legacy recuperabile, senza subject o collegamento amministrativo, in una pratica ancora aperta. Una nuova attivazione restituisce `contact_admin`: il contratto attuale non offre un recupero pubblico senza prova legacy. Anche richieste già collegate richiedono assistenza; una pratica in esecuzione restituisce `wait`, una pratica terminale non propone recupero. Discovery, replay e recupero usano gli stessi criteri server. Con `contact_admin`, `auth.signIn` restituisce `pending` senza invocare `verifyLegacy`, creare challenge o rilasciare sessioni.

La UI chiede due campi distinti: password locale per la prova, nuova password per Connect. La facciata confronta le due, rifiuta valori uguali, verifica di nuovo il legacy e invia **solo la nuova credenziale** a `POST /v1/app-onboarding/password-recovery`. La password locale non viene inviata in questo recupero. Il consenso è legato al challenge monouso verificato.

Il contratto backend di recupero richiede schemaVersion, appId/sourceId, requestId, localTenantId, localUserId, email, consentVersion e newPassword. Il bearer della sorgente autentica il backend che **attesta** prova legacy fresca, consenso e distinzione delle password: Connect non può verificare la password del database locale. Se si usa il metodo basso livello `ConnectOnboardingSource.recoverPassword`, il chiamante deve attuare questi controlli; per la prossima app utilizzare `ConnectApplication.migration.submit`.

Il server blocca la pratica con lo stesso lock usato da esecuzione/rifiuto, verifica sorgente/app/ID locali, richiede stato failed + password_change_required, assenza di subject/collegamento esplicito e una **nuova chiave idempotente**. Cifra la nuova password con AAD requestId e TTL esistenti, imposta pending, non crea identità né esegue la migrazione automaticamente. L’amministratore deve eseguire la pratica. La chiave di recupero resta riservata: lo stesso invio restituisce lo stato corrente e non sostituisce la credenziale; una nuova credenziale dopo un altro rifiuto richiede un’altra chiave e una nuova prova/consenso. Non cambia hash legacy o password di identità esistenti.

## Atomicità e concorrenza

Store PostgreSQL: transazioni READ COMMITTED, lock advisory **di sessione** su namespace + chiave del flusso/sessione. Occorre un Pool con connessioni dedicate fino al rilascio; non usare PgBouncer in transaction pooling. I lock sono rilasciati anche su rollback; una connessione persa rilascia il lock nel server PostgreSQL. Timeout lock 15 secondi; chiamate OIDC/sorgente con timeout 10 secondi. Dimensionare il pool in base alla concorrenza; gli handler non devono mantenere altre transazioni locali in attesa dello stesso flusso.

- State, nonce, PKCE e contesto sono cifrati AES-256-GCM con AAD source/app/record; cookie contiene solo un valore casuale correlato.
- Callback: consumo state **prima** del grant, in transazione già confermata. Un crash impedisce il replay ma richiede nuovo login. TTL 10 minuti. ID token verificato con JWKS, issuer, audience, azp, nonce e subject; accesso e mapping locali verificati nuovamente.
- Handoff: TTL 60 secondi; cookie correlato, lock esclusivo, verifica accesso, provisioning e consumo nella stessa transazione. Se il provisioning usa `transaction.sql` sullo stesso database, i suoi cambiamenti e il consumo sono atomici. Non chiamare `checkpoint()` nell’adattatore account.
- Database diverso: nessuna promessa di transazione distribuita. Usare `operationId` come chiave idempotente persistente nel sistema locale e riconciliare una chiamata ripetuta dopo rollback/crash; restituire sempre gli stessi ID autorizzati. Il flusso può richiamare provision più volte, ma deve produrre un solo profilo.
- Sessioni: scadenza assoluta (8 ore di default, configurabile 60–604800 secondi), refresh preventivo sotto 30 secondi. Ogni resolve/azione riverifica sorgente e `/v1/access`, includendo subject, app, installazione e ID locale. Nessuna fiducia in una licenza memorizzata nel cookie.
- Refresh: lock per sessione fra processi. Un timestamp condiviso deduplica refresh forzati per 5 secondi. Prima del grant viene scritto un intento cifrato e chiamato `checkpoint()` (commit che **mantiene il lock di sessione**). Una nuova generazione diventa valida solo al commit del nuovo token. Timeout, risposta ambigua o crash conservano l’intento e rendono inutilizzabile la vecchia sessione; nuovo SSO richiesto, mai replay del vecchio refresh token. Gli intenti scadono con la sessione e vengono rimossi dal pruning.
- Logout: revoca locale durevole sotto lo stesso lock, prima del logout provider. `providerRevoked:false` segnala il fallimento remoto; `null` segnala nessuna credenziale disponibile e nessun tentativo remoto; la sessione locale resta revocata. Dopo una revoca rilevata da resolve la sessione provider può restare attiva nel provider fino a scadenza/logout globale; non si certifica revoca globale senza conferma.
- Nessuna chiamata applicativa viene ritentata automaticamente dopo rinnovo o risposta incerta.

Eseguire `store.prune()` periodicamente per eliminare ciphertext scaduti. Scadenza e consumo vengono comunque verificati a ogni lettura; il pruning non è una condizione per la sicurezza. Non registrare request body, cookie, state/code, token o ciphertext in audit applicativi.

## Servizi esistenti e diagnostica

```ts
await connect.services(sessionId, (server, token) => server.teamOverview(token));
await connect.services(sessionId, (server, token) => server.whatsapp(token).outbox());
await connect.services(sessionId, server => server.registerFunctions(catalogUrl));
const report = await connect.diagnose(emailFacoltativa);
```

`services` condivide contesto e sessione autenticati; non consegnare la callback o il token al frontend. Configurare l’URL del catalogo esplicitamente per `registerFunctions(catalogUrl)`.

`ConnectApplicationError.code` è un’unione sicura: invalid_configuration, invalid_credentials, invalid_context, invalid_flow, invalid_consent, invalid_password, access_denied, session_expired, provider_unavailable, provision_conflict. Il BFF deve rendere soltanto code tipizzati; per le API basso livello restano gli errori compatibili precedenti. Non esporre errori database/provider grezzi.

`diagnose` è read-only: verifica configurazione già validata dal costruttore, discovery issuer e autenticazione sorgente. `authorization` resta `not_checked`: né discovery, né email, né raggiungibilità certificano un token utente, client OIDC autorizzato, licenza o associazione applicativa. Il costruttore segnala la configurazione non valida con `invalid_configuration`; `ConnectApplication.diagnose(config)` permette alla CLI di ottenere un report tipizzato anche prima della costruzione valida. Nessun segreto nei risultati. Per ALORA la configurazione richiesta è descritta in `docs/SDK-ALORA-DEVELOPMENT.md` del repository Connect; Il riferimento iniziale era ALORA in sola lettura; per l’adozione consumer successiva vedere la sezione finale di questa guida.

## Esempio e verifica

`examples/workshop` è un’app eseguibile con pagine HTML, BFF Node, account/project store SQL, migrazioni, diagnostica e seed legacy esplicito. Copiarla e installare il tarball; non copia alcun protocollo. I test `connect-application.test.ts` coprono provider simulato e possono usare PostgreSQL reale con `CONNECT_SDK_TEST_DATABASE_URL`. `node scripts/check-sdk-real-provider.mjs` crea e rimuove PostgreSQL e Keycloak temporanei: recupero password reale, SSO/PKCE/ID token, refresh e revoche; Connect usa il proprio harness PGlite e amministrazione simulata. Il report distingue esattamente questi livelli. Browser grafico, proxy/TLS pubblico e produzione richiedono collaudi separati.


## Riutilizzo nelle app e stato del consumer ALORA

Il consumer ALORA ha adottato presenter e configuration.sync della candidata schema 013, eliminando il proprio percorso enrollment separato. La configurazione tecnica è predisposta; il collaudo utente finale non è stato eseguito automaticamente. Non confondere l’emissione del presenter con l’approvazione di un’integrazione.

Una nuova app riusa lo stesso modulo, store e metodi; implementa soltanto adattatori di dominio e HTTP. Eventuali token/sessioni legacy dell’app restano un adattatore di compatibilità, non un secondo protocollo da propagare. Lo SDK attuale assume endpoint provider Keycloak, appOrigin/callback nella stessa origine e quattro ruoli locali interoperabili (owner/manager/reception/collaborator). Altri modelli devono essere adattati esplicitamente senza ampliare permessi, o richiedono un’evoluzione coordinata del contratto. Questo limite non riguarda i ruoli Connect configurabili e le permission key applicative.

La facciata non risolve da sola DNS/TLS del deployment: issuer canonico, URL catalogo ammesso e raggiungibilità da browser/backend/Connect devono essere configurati nell’ambiente reale. Il client OIDC dedicato resta una responsabilità amministrativa. Non usare localhost nel container presumendo che indichi l’host.


## Origine di trasporto backend del provider

`oidcTransportOrigin` opzionale configura esclusivamente l’origine delle chiamate server discovery/token/JWKS/logout, preservando il percorso del realm. È un parametro server amministrativo, non ricevuto dal browser. Sono ammessi solo HTTPS o HTTP loopback con opt-in esplicito; path diversi da `/`, query, fragment e credenziali sono rifiutati.

L’issuer canonico resta quello approvato: URL di autorizzazione nel browser, confronto `iss`, audience, nonce e PKCE non vengono riscritti né disattivati. Un esempio Docker locale è issuer `http://localhost:8080/realms/eulab` e origine di trasporto `https://nginx`, con CA attendibile e relay privato verso il medesimo Keycloak. Non usare il parametro per collegare un provider diverso dall’issuer approvato.

Correzione del 24 ottobre adottata per il problema di raggiungibilità rilevato in ALORA dopo la migrazione. Compilazione/pacchetto aggiornati; il login end-to-end viene riprovato dall’utente, non è dichiarato collaudato da questa modifica.

## Candidata 0.11.0 — account squadra

La candidata aggiunge `application.team.createUser(sessionId, input)`, usando la stessa istanza e la sessione backend già approvata. L'input contiene il profilo locale persistito (`localUserId`, email, nome/cognome, ruolo operativo e permessi), i `roleIds` esplicitamente scelti e una password iniziale facoltativa. Sorgente e azienda locale derivano dalla configurazione/sessione; lo username è generato se omesso. Non aggiungere un signup parallelo o chiamate amministrative nel browser.

Richiede API Connect aggiornata, migrazione 014 e bootstrap degli attributi provider riservati. La creazione conserva le restrizioni di licenza/delega e non sostituisce revisioni o riattivazioni amministrative. Risultato tipizzato `ApplicationTeamUserResult`; errori `ConnectApiError` con `status` e `code`. I rifiuti di business conservano la sessione operatore; nessun reinvio automatico di password o mutazioni dopo esiti incerti. `ssoSetupRequired` segnala eventuali azioni provider ancora necessarie.

La distribuzione npm 0.10.0 non contiene questo metodo. Questa candidata non comporta pubblicazione automatica. Specifica completa ed evidenze nel repository Connect: `docs/DELEGATED-ACCOUNTS-STEP-5.md`.


## Automazioni appuntamenti — 0.12.0

Il contratto server aggiuntivo è in [AUTOMATIONS.md](./AUTOMATIONS.md): `ConnectServer.automations(token)` per consenso/recupero, `ConnectServer.automations()` per worker con credenziale delegata. Richiede schema 015 e API/runner aggiornati insieme. La facciata esistente `services(sessionId, callback)` permette l’autorizzazione iniziale senza esportare token al browser. Persisti grant e segreto webhook cifrati nel backend; al browser proietta soltanto stato, scadenza e motivo sicuro. Non usare refresh token UI per job differiti e non cambiare chiave dopo un esito incerto.

La versione 0.12.0 aggiunge `client.automations().withdraw(id, credential, originalInput, originalKey)`. Usa gli stessi dati/chiave di `send`, senza token browser. Una ricevuta `cancelled` preventiva impedisce il commit tardivo di un nuovo invio; `sending`/`sent`/`uncertain` producono `effect_started`, senza annullamento promesso o reinvio. Contratto e unione tipizzata `DelegatedMessageWithdrawal` in [AUTOMATIONS.md](./AUTOMATIONS.md#ritiro-del-singolo-comando-0120-rc2). Nessuna nuova migrazione oltre allo schema 015.
