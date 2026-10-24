# Attivazione assistita e migrazione obbligatoria

Contratto backend-to-backend per le applicazioni che devono attivare un’azienda o migrare account locali. ALORA è il primo consumer verificato; il contratto non è specifico di ALORA.

## Ruoli e confini

- Una **credenziale tecnica presenter** può essere emessa senza app o sorgente registrata. La prima chiamata riserva una provenienza non approvata. Le sorgenti già registrate restano compatibili.
- Il **backend della sorgente** usa una credenziale bootstrap e riusa gli endpoint app-onboarding esistenti. Non usa credenziali Admin EULAB e non espone il segreto al browser.
- La **lookup** `login-context` è un instradamento: non autentica la persona e non crea sessioni.
- L’identità resta `issuer + subject`; cliente, applicazione, installazione, ruoli, licenza e revoche restano autorevoli in Connect.
- Nessuna associazione o fusione automatica per email. Un conflitto richiede un collegamento esplicito dell’amministratore.

## Endpoint sorgente

Ogni richiesta richiede TLS (HTTP loopback ammesso solo in sviluppo), `Authorization: Bearer <bootstrap-secret>`, `X-Connect-Source: <sourceId>` e il body comune `{schemaVersion:1, appId, sourceId}`. La sorgente autenticata deve coincidere con `sourceId` e `appId`. Limite: 120 richieste al minuto per sorgente e socket; risposte `Cache-Control: no-store`. In ambiente `production` origini, catalogo e callback OIDC devono usare HTTPS.

Alternativa schema 013: `X-Connect-Presenter: <presenterId>` e Bearer del presenter; body comune invariato più `deployment:{name,environment,origins,catalogUrl,oidcCallbacks}`. `X-Connect-Source` se presente deve coincidere. Il primo utilizzo lega irrevocabilmente credenziale e sourceId; una collisione è 409, non una presa di possesso. La credenziale tecnica non abilita SSO o operazioni. Origini/app verificate sono attestazioni dell’amministratore, distinte dalle dichiarazioni.

Gli admin gestiscono `GET/POST /v1/onboarding/presenters`, `PUT /v1/onboarding/presenters/:id` (abilitazione, scadenza, rotateSecret). Il segreto è restituito solo all’emissione/rotazione. Il consumer non riceve credenziali Admin.

`POST /v1/app-onboarding/configuration`, con la stessa autenticazione backend, restituisce pending (eventuale plannedAppId non autorizzativo), configuration_required o ready con configurazione SSO cifrata a riposo e consegnata solo al server autenticato. Nessun recupero con solo deploymentId. Per presenter approvati login-context può restituire `configuration_required` con contesto backend: non pubblicarlo al browser. La facciata rende solo lo stato sicuro.

### `POST /v1/app-onboarding/login-context`

Body aggiuntivo: `{email}` (normalizzata). Risposte:

```json
{"status":"connect","context":{
  "tenant":{"id":"local-tenant-id","name":"Azienda","slug":"azienda"},
  "binding":{"customerId":"uuid","installationId":"uuid","secret":"segreto-server-installazione"},
  "user":{"id":"local-user-id","subject":"provider-subject","email":"persona@example.test","firstName":"Nome","lastName":"Cognome","role":"reception","permissions":["agenda.read"]}
}}
```

```json
{"status":"not_found","request":{"requestId":"uuid","state":"pending"}}
```

Il contesto è restituito soltanto per un `app_local_users` esplicito e abilitato, con installazione e binding attivi, identità e appartenenza abilitate, licenza attiva e non scaduta, ruolo assegnato e nessuna revoca. Il segreto server proviene dalla copia cifrata `installations.secret_cipher`; le installazioni storiche prive di copia richiedono una rotazione esplicita. Ambiguità o più accessi autorizzati: `409`. Account sospesi, revocati o licenza non attiva: `403`. La lookup non deve diventare `not_found` per timeout, errori di servizio o contratto assente.

Il consumer rivalida il contesto dopo il callback OIDC. `/v1/access` deve restituire gli stessi `appId`, `installationId`, `localUserId` e `subject`.

### `POST /v1/app-onboarding/requests`

Header obbligatorio `Idempotency-Key` (8–200 caratteri, ad esempio SHA-256 esadecimale). Body migrazione:

```json
{
  "schemaVersion":1,
  "appId":"alora",
  "sourceId":"alora-produzione",
  "kind":"migration",
  "consentVersion":"2026-10-21-mandatory-v1",
  "localTenant":{"id":"tenant-1","name":"Azienda","slug":"azienda"},
  "localUser":{"id":"user-1","email":"persona@example.test","firstName":"Nome","lastName":"Cognome","role":"owner","permissions":["agenda.read"]},
  "initialPassword":"password-verificata-localmente"
}
```

Body attivazione:

```json
{
  "schemaVersion":1,
  "appId":"alora",
  "sourceId":"alora-produzione",
  "kind":"activation",
  "companyName":"Nuova Azienda",
  "applicant":{"email":"nuovo@example.test","firstName":"Nuovo","lastName":"Titolare"},
  "initialPassword":"password-scelta"
}
```

Risposta: `{requestId, state}` con stato `pending|approved|migrating|completed|rejected|expired|failed`. La stessa chiave con lo stesso body restituisce la pratica esistente. La stessa chiave con un body diverso restituisce `409` e non sostituisce la credenziale. Una nuova chiave per la stessa persona restituisce la richiesta esistente senza acquisire una seconda password, salvo che la precedente sia già rifiutata o scaduta.

Se la richiesta è `rejected`, `expired` o `failed` con `action_required=new_request_required` e la pratica non è chiusa, anche la stessa chiave può essere riusata con una nuova password: la richiesta e la pratica restano le stesse, senza duplicati, e la credenziale precedente è già stata cancellata. Il rifiuto o la scadenza dell’intera pratica restano definitivi per la sorgente.

## Custodia della password transitoria

- Cifratura AES-256-GCM con `MIGRATION_ENCRYPTION_KEY` (32 byte esadecimali), AAD = ID richiesta. Chiave distinta da `DATA_ENCRYPTION_KEY`.
- TTL `ONBOARDING_PASSWORD_TTL_SECONDS` (default 86400; minimo 60, massimo 604800).
- La password non compare in risposte, elenco pratiche, dettaglio, audit, log o errori. Il pannello vede solo presenza, scadenza e avvenuta cancellazione.
- Cancellazione effettiva al completamento, rifiuto, scadenza o credenziale non più utilizzabile. Un processo periodico elimina le copie scadute.
- Se il provider rifiuta la password per policy, la pratica mostra `password_change_required` e cancella la copia; nessun reset silenzioso. MFA, verifica email e azioni obbligatorie restano nel provider.
- La chiave è letta soltanto dal servizio di esecuzione della migrazione. Non viene restituita all’admin, all’SDK browser o alla sorgente.

## Amministrazione EULAB

Tutti gli endpoint seguenti richiedono un Admin EULAB autenticato.

| Metodo | Percorso | Uso |
|---|---|---|
| GET | `/v1/connect-sources` | Elenco sorgenti senza segreti |
| GET | `/v1/connect-sources/:id` | Binding installazioni/aziende e accessi locali |
| POST | `/v1/connect-sources` | Registra la sorgente; restituisce il segreto bootstrap una sola volta |
| PUT | `/v1/connect-sources/:id` | Aggiorna ambiente, origini, catalogo, callback, stato; `rotateSecret` |
| POST | `/v1/connect-sources/:id/installations` | Collega un’installazione della stessa app e origine |
| POST | `/v1/connect-sources/:id/local-users` | Preassegna `localTenantId`, `localUserId`, subject e ruolo locale |
| DELETE | `/v1/connect-sources/:id/local-users/:installationId/:localUserId` | Rimuove il collegamento esplicito |
| GET | `/v1/onboarding/practices` | Elenco pratiche con conteggi e scadenza credenziali |
| GET | `/v1/onboarding/practices/:id` | Dettaglio, prerequisiti, richieste e piano |
| PUT | `/v1/onboarding/practices/:id/plan` | Salva licenza, ruoli, assegnazione di attivazione e collegamenti espliciti |
| POST | `/v1/onboarding/practices/:id/prepare` | Crea/riusa applicazione, cliente, installazione e catalogo |
| POST | `/v1/onboarding/practices/:id/execute` | Esegue la migrazione idempotente |
| POST | `/v1/onboarding/practices/:id/reject` | Rifiuta la pratica e cancella le credenziali |
| POST | `/v1/onboarding/practices/:id/requests/:requestId/reject` | Rifiuta una singola persona |

Il pannello **Attivazioni e migrazioni** mostra applicazione/deployment/origine verificata, azienda locale, richiedente, ruolo locale, date, prerequisiti, stato ed errori sicuri. «Esegui migrazione» è abilitato solo quando il piano contiene licenza, ruoli e prerequisiti. Il piano permette selezione/creazione di applicazione, cliente e installazione, oltre a licenza, ruoli, assegnazione locale e subject espliciti. AppId dichiarato non verifica la proprietà. Per i nuovi presenter prepare è una verifica senza creazioni; execute applica il piano con checkpoint ripetibili. Una sospensione/revoca non viene riabilitata dal piano. La configurazione SSO è cifrata separatamente e mai mostrata con il segreto nel dettaglio.

### Piano

```json
{
  "license":{"state":"active","expiresAt":null,"features":[{"key":"agenda.read","purchased":true,"enabled":true}]},
  "roles":[{"localRole":"owner","roleName":"Titolare","permissions":["agenda.read"]}],
  "activation":{"localTenantId":"tenant-1","localUserId":"user-1","localRole":"owner"},
  "identities":{"request-uuid":"provider-subject-verificato"}
}
```

Le funzioni devono esistere nel catalogo attivo. I permessi dei ruoli devono essere coperti dalla licenza approvata. `activation` vale solo per le pratiche di attivazione. `identities` è l’unico modo per collegare un’identità esistente e richiede una verifica esplicita dell’amministratore.

## Esecuzione

Fasi: claim atomico della pratica, verifica prerequisiti, creazione/riuso applicazione, cliente e installazione, sincronizzazione del catalogo, licenza e funzioni, per ogni persona identità, appartenenza, ruolo, assegnazione e collegamento locale, quindi chiusura della pratica.

- Nessuna creazione duplicata su retry. L’identità creata dal provider è recuperabile tramite l’attributo della richiesta; il retry non reimposta la password.
- Il rifiuto della pratica o di una persona acquisisce il lock della pratica usato dal claim di esecuzione: se il rifiuto arriva prima del claim, l’esecuzione lo rispetta; se la pratica è già `migrating`, il rifiuto restituisce `409` senza modificare stato o credenziali. Non è disponibile una cancellazione di operazioni provider già in corso. Nuove persone non possono riaprire una pratica `rejected`/`expired` e ricevono `409`; durante `migrating` devono attendere. I reinvii riutilizzano l’ID persistito anche come AAD della nuova credenziale.
- Un’esecuzione interrotta può essere ripresa. Claim concorrenti e timeout non duplicano app, clienti, installazioni, ruoli o assegnazioni.
- Un conflitto di email/subject produce `failed` con `action_required=explicit_link_required`, cancella la credenziale e non modifica l’identità esistente.
- Un’identità o appartenenza sospesa non viene riattivata automaticamente.
- La pratica non è mai completata se una richiesta resta aperta o fallita.

## Configurazione

```sh
MIGRATION_ENCRYPTION_KEY=<64 caratteri esadecimali>
ONBOARDING_PASSWORD_TTL_SECONDS=86400
```

`npm run security:prepare`/gli script di inizializzazione generano la chiave nei nuovi file ambiente. Non riutilizzare `DATA_ENCRYPTION_KEY`. Applicare la migrazione `011-app-onboarding.sql` prima di avviare API e web. Le installazioni esistenti senza `secret_cipher` devono ruotare le credenziali dal pannello prima di poter fornire il contesto.

La rotazione o la perdita di `MIGRATION_ENCRYPTION_KEY` rende illeggibili le password transitorie ancora pendenti: non esiste escrow né recupero. In quel caso le pratiche interessate vanno rifiutate e il richiedente deve ripetere l’accesso; la chiave non va mai cambiata mentre esistono credenziali pendenti senza una procedura di drenaggio.

## Limiti e verifiche

- La lookup non è autenticazione. La sessione resta OIDC Authorization Code + PKCE; nessun password grant.
- Il consumer deve trattare `403` come sospensione/revoca, `409` come conflitto da verificare e gli altri errori come servizio non disponibile, mai come `not_found`.
- La protezione SSRF si basa su origini registrate, URL di catalogo/callback appartenenti a un’origine autorizzata e nessun fetch di URL forniti dall’utente.
- Test automatici simulati: `tests/onboarding.test.ts` (bootstrap, lookup, revoche, ambiguità, TTL, cifratura, idempotenza, conflitto email, collegamento esplicito, attivazione, risposta provider persa e retry senza duplicati).
- Collaudo reale separato: `node scripts/qa-onboarding.mjs` usa lo stack Docker locale (Keycloak, PostgreSQL, API e browser) su `http://localhost:8088`. Verifica login Admin PKCE, sorgente prima dell’app, lookup, `/v1/access`, sospensione licenza, richiesta idempotente, esecuzione dal pannello, cancellazione della password, nuova identità Keycloak con la stessa password e accesso coerente. Crea solo dati QA con suffisso casuale e li rimuove; evidenza in `docs/verification/onboarding/`.
- Il dominio pubblico Connect non è disponibile. I test non pubblicano, non distribuiscono e non creano clienti, licenze o segreti operativi.
