# SDK Connect 0.10.0 — consegna e verifiche

Consolidamento locale del 24 ottobre 2026: [allineamento pratiche, risultati e limiti](ONBOARDING-PLAN-ALIGNMENT.md). Docker sviluppo aggiornato su richiesta con schema 013, API e web verificati. La sezione storica qui sotto descrive la consegna precedente del 22 ottobre e la correzione activation; non certifica il nuovo percorso sull’installazione ALORA effettiva.

Consegna precedente del 22 ottobre 2026. Nessuna pubblicazione npm, distribuzione esterna o modifica del repository ALORA. La candidata resta 0.10.0; l’API Docker di sviluppo è aggiornata alla correzione descritta sotto. Lo schema 012 era già presente e non è stato riapplicato in questo intervento. Le modifiche già presenti nel checkout Connect sono state preservate; questa consegna aggiunge la facciata e consolida il contratto sorgente disponibile.

## Artefatti correnti

- Tarball: `dist/releases/sdk/eulab-connect-0.10.0.tgz`.
- SHA-256: `938a998004345cf650cbeb1881cf3f33df465ce3e806848a3ed436044abc56a1`.
- Manifest file/export/checksum: `dist/releases/sdk/manifest.json`, `SHA256SUMS`.
- Guida completa: [INTEGRATION.md](../packages/sdk/INTEGRATION.md).
- Esempio completo BFF Node/PostgreSQL: [Workshop](../packages/sdk/examples/workshop/README.md), incluso nel pacchetto.
- Configurazione sorgente ALORA: [SDK-ALORA-DEVELOPMENT.md](./SDK-ALORA-DEVELOPMENT.md).
- API compatibili 0.9.0: browser/server/onboarding/team. Nuovo import `@eulab/connect/application`.

## Verifica automatica del consolidamento precedente

`npm test`: **102 test passati, zero fallimenti, zero skip**. Inclusi i nove casi della facciata e il recupero server, oltre alle regressioni SDK/API preesistenti. `npm run build`, `docker compose config --quiet` e `git diff --check` passati. L’SDK viene inoltre compilato da `prepack` e installato offline in un consumer temporaneo: export ESM browser/server/application e dichiarazioni TypeScript verificati.

La suite comprende discovery prima del legacy, risposta malformata senza fallback, nessuna sessione locale in attesa, proof/consenso/cookie, replay callback e handoff concorrenti, timeout dei flussi, subject/ID locale/azienda errati, conflitti di provisioning, riconciliazione idempotente, accesso e revoche, rinnovi serializzati, risposta di refresh incerta e crash dopo un grant con intento durevole. Il recupero server prova chiavi riservate, ripetizioni senza sostituzione della credenziale, sorgente/azienda estranee e rifiuto di pratiche in esecuzione o terminali. Password e token assenti dagli esiti UI/audit verificati.

## Provider simulato e store PostgreSQL reale

`node scripts/check-sdk-real-provider.mjs` ha ripetuto i casi della facciata con PostgreSQL 17.6 temporaneo, due Pool indipendenti e namespace condiviso, per verificare i lock del vero adattatore. Otto casi eseguiti sullo store reale; il caso di crash con errore di commit iniettato viene intenzionalmente saltato in questa variante e passa sullo store deterministico della suite ordinaria. OIDC/Connect in questi sette casi sono simulati.

## Keycloak reale e seconda applicazione

Lo stesso comando ha creato un Keycloak temporaneo, realm dedicato con policy `length(20)` e rotazione refresh, client BFF pubblico PKCE e audience Connect. Ha verificato:

1. Password legacy valida localmente ma rifiutata dalla policy reale: richiesta failed/password_change_required, ciphertext eliminato, nessuna identità provider e nessun provisioning locale.
2. Nuova prova legacy e consenso, nuova password Connect distinta, invio esplicito; nessuna creazione identità fino all’esecuzione amministrativa della pratica.
3. Identità creata con la nuova password; vecchia password incapace di autenticare Connect; hash legacy invariato.
4. Authorization Code/PKCE, nonce e ID token con firma JWKS reali, callback/handoff monouso, provisioning e cookie di sessione.
5. Rinnovi concorrenti, blocco della required action UPDATE_PASSWORD e revoca licenza. Logout effettivo del provider con introspection del precedente access token `active:false`.
6. Installazione offline del tarball in una cartella consumer esterna, esecuzione dell’esempio Workshop senza import dai sorgenti Connect/ALORA: migrazioni, seed legacy esplicito, diagnostica, SSO reale, callback BFF, handoff, progetti filtrati per azienda, refresh/logout e hash legacy preservato.

**Confini del collaudo reale:** Keycloak e store SDK PostgreSQL sono reali e temporanei; il database Connect è PGlite, l’autenticazione amministrativa Connect è simulata, il catalogo è una fixture iniettata. I token utente OIDC, verifica della firma e introspection sono reali. La UI provider viene attraversata via HTTP, senza browser grafico. Il test non certifica la configurazione della sorgente ALORA operativa, il recupero nel suo backend attuale, il catalogo HTTPS pubblico, MFA completa o la produzione.

Report macchina: `docs/verification/sdk-0.10.0-real.json`, risultato `passed`, `cleanupVerified:true`, `realBrowser:false`, `production:false`; provider temporanei rimossi. Questo report è ignorato da Git per convenzione del repository, insieme agli altri output locali di verifica.

## Adozione e limiti residui

Il recupero richiede **schema Connect 012**, già verificato sul Docker locale con 12 migrazioni registrate. La correzione dell’azione non aggiunge SQL e non riesegue migrazioni. La migrazione dello store SDK 001 appartiene invece al database del consumer.

Il Pool PostgreSQL dello store richiede connessioni di sessione, non PgBouncer transaction pooling. Con provisioning su un altro database occorre una riconciliazione idempotente persistente tramite operationId; non è promessa atomicità distribuita. Dopo un grant incerto/crash la facciata richiede nuovo SSO e non ripete il refresh token. La revoca locale non equivale automaticamente a logout globale del provider: l’esito remoto resta esplicito, o `null` se non è stato possibile effettuare un tentativo perché la sessione era già assente.

ALORA ha segnalato l’adozione di SDK 0.10.0 e fornito la riproduzione del difetto di attivazione; il percorso autorizzato sull’installazione effettiva resta da collaudare separatamente. Questo intervento non modifica il repository ALORA. Browser grafico, reverse proxy/TLS pubblico, catalog reader operativo e accettazione di produzione restano collaudi distinti.


## Consolidamento candidata: azione dopo rifiuto password di attivazione

La regressione nuova è stata eseguita prima della correzione e ha riprodotto due errori: `choose_connect_password` per una nuova attivazione e per una migrazione con subject già assegnato nel piano amministrativo. Il test autonomo della facciata con `contact_admin` era già verde: il difetto era nella decisione server.

Discovery, risposta/replay della richiesta e replay del recupero ora leggono una proiezione comune di tipo richiesta, stato pratica, subject personale, assegnazione nel piano e collegamento locale per source/app/tenant/user ID. Il recupero di una nuova password usa la medesima decisione, mantenendo i lock già previsti. Per le attivazioni senza prova legacy l’azione è `contact_admin`; non è stato introdotto un recupero pubblico. Le pratiche in esecuzione danno `wait`, quelle terminali non pubblicizzano recupero; i collegamenti espliciti danno assistenza. Il recupero delle migrazioni non collegate in una pratica aperta mantiene nuova prova legacy, consenso, nuova chiave e password distinta.

Regressioni server e facciata: assistenza `pending` senza verifica legacy, accessi allo store/challenge, provisioning o sessioni, sia con password fornita sia assente; vincoli terminali/in esecuzione; subject pianificato/persistito e collegamento locale anche con email differente o disabilitato; reinvio e replay idempotente; attivazione con credenziale scaduta o nuova richiesta necessaria. Nessuna identità provider creata dal test di attivazione.

La riproduzione ALORA è stata rieseguita dal cwd Connect, così il report viene scritto qui e ALORA resta invariato:

```sh
CONNECT_CHECKOUT='/Users/eugeniorenna/eulab connect' node /Users/eugeniorenna/barber/scripts/check-connect-activation-action.mjs
```

Risultato: `contact_admin`, recovery HTTP 409, `passed`, cleanup verificato. Report: `docs/verification/connect-activation-action.json`. È un collaudo con API/harness Connect e PGlite temporaneo: viene iniettato lo stato di rifiuto, non è un collaudo Keycloak dell’attivazione. La suite completa è 102/102 e il ricollaudo Keycloak temporaneo del recupero **migrazione** e dell’app Workshop passa; i confini simulati/reali restano quelli sopra.

L’API Docker di sviluppo è stata ricreata con il nuovo bundle; hash confrontato col compilato locale, health HTTP 200 e schema 012 invariato. PostgreSQL accetta la nuova query di stato in verifica read-only. Report: `docs/verification/connect-activation-action-deployment.json`. La build usa la base runtime locale e una configurazione Docker temporanea per evitare il blocco del Portachiavi macOS; non modifica le credenziali Docker globali. Nessun riavvio di DB/Keycloak, nessuna pubblicazione e nessun invio di credenziali sull’installazione effettiva.

## Consumer Docker transport update — 2026-10-24

The current unpublished 0.10.0 candidate adds the backend-only `oidcTransportOrigin` option. SHA-256: `2e07f936a8d52b9ff47862dcd674e0afa39fe0a4c9919ffa37d4cd9380cc294d`. This revision was compiled and adopted in ALORA; technical discovery from the ALORA container returns HTTP 200 with the canonical issuer unchanged. The previously recorded functional suite results predate this transport change. No new login/provider-flow acceptance or automated functional suite was run; ALORA user acceptance remains pending.

### Diagnostica callback

Il nuovo tentativo manuale dell’utente arriva al callback e torna ancora con `connect_error=access_failed`. Il trasporto raggiungibile non basta a certificare il login. La candidata SDK annota ora gli errori callback con `callbackStage` (flow, token_exchange, id_token, context, authorization, handoff), mantenendo invariato il codice di errore. ALORA registra soltanto fase e codice da elenchi chiusi nel log backend `[connect-callback]`; non registra query, messaggi provider, token o identità. Questa diagnostica operativa resta disponibile per individuare il punto esatto al prossimo tentativo dell’utente. Compilazioni e lint passati; nessun login automatico o modifica della pratica.

## Deployment client audience correction

Real ALORA user testing exposed a separate provisioning defect after ID-token verification: the dynamically generated client had no connect-api audience mapper. The provisioning service now reconciles that mapper only after deployment ownership and callback validation. The existing ALORA client was repaired using the provider management API; no identity, license, role, practice, or password changed. API compilation passed; intake fixture/assertions updated, functional tests not rerun. This is server-side and does not change the SDK tarball. Full user login acceptance remains pending.

Aggiornamento runtime: compilazione/bundle Connect completati e API Docker sostituita con il bundle corretto. Il rebuild multistage ordinario era bloccato dal DNS di auth.docker.io; usata l’immagine runtime locale esistente come base, con il solo nuovo api.mjs compilato (SHA-256 d94290bc0e4b63f1511d372c1f2403c5d9f52c45be6618ea677f30aa93df7b8a). Dipendenze invariate, immagine precedente conservata nel tag locale pre-audience-fix. Health HTTP 200; nessuna pubblicazione o deploy di produzione. Il build ordinario resta da ripetere quando il registry è raggiungibile.

Il tentativo manuale successivo resta negato in authorization. Verifiche tecniche senza login: contesto sorgente disponibile; credenziale installazione accettata da /v1/access senza bearer (200, expected installation_or_identity_missing); introspezione con token fittizio risponde 200; mapper audience presente. Queste prove non attestano l’accettazione del bearer utente. Aggiunta classificazione chiusa authorizationDetail nello SDK e log Connect della fase di verifica JWT/introspezione (solo codici e nomi di claim ammessi, nessun valore/token). La causa residua resta da identificare dal prossimo tentativo manuale.

Il tentativo manuale delle 20:54 UTC restituisce http_401, verifica bearer nella fase signature. Il client generato aveva soltanto profile/email; lo scope basic, che nel realm Keycloak corrente contiene il mapper oidc-sub-mapper per access token/introspezione, era assente. Riallineati gli scope default via provider Admin API dopo verifica proprietà del client: profile/basic/email. Il provisioning crea basic/profile/email e riconcilia basic mancante sul client di proprietà; se il provider non dispone di basic fallisce esplicitamente. Fixture/asserzioni aggiornate, bundle compilato; nessuna suite funzionale rieseguita. Non sono cambiati account, password, ruoli, licenze o collegamenti. Il test di ingresso completo resta dell’utente.

## Conferma manuale dell’utente — 24 ottobre 2026

Dopo il riallineamento del client OIDC (audience connect-api e scope basic), l’utente ha confermato che l’accesso all’admin ALORA funziona. È una verifica manuale sull’installazione Docker locale: non equivale al collaudo di rinnovo, revoca, permessi, MFA o produzione. Nessuna migrazione o sessione utente è stata eseguita automaticamente per questa verifica.
