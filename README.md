# EULab Connect

## SDK applicativo 0.10.0

Per nuove app: presenter tecnico → richiesta negli endpoint esistenti → scelta/creazione amministrativa → configuration.sync server → SSO. Non serve un intake parallelo. ALORA ha adottato il percorso; il collaudo utente resta da eseguire. [Contratto, livelli di evidenza e vincoli di riuso](docs/ONBOARDING-PLAN-ALIGNMENT.md).


Facciata server indipendente dai framework, store PostgreSQL condiviso, recupero password con prova legacy separata ed esempio Workshop. [Guida SDK](packages/sdk/INTEGRATION.md), [allineamento pratiche e bootstrap](docs/ONBOARDING-PLAN-ALIGNMENT.md), [configurazione ALORA sviluppo](docs/SDK-ALORA-DEVELOPMENT.md), [verifiche e limiti](docs/SDK-0.10.0-VERIFICATION.md). `npm run package:sdk` genera il tarball locale; `npm run test:sdk:real` verifica provider temporanei. Nessuna pubblicazione automatica.


## Repository
Connect: https://github.com/Eulab-EugenioRenna/connect

OpenWAUnlocked è mantenuto nella repository separata https://github.com/Eulab-EugenioRenna/openwaunlocked e collegato qui come submodule in `openwaunlocked/`.

```sh
git clone --recurse-submodules https://github.com/Eulab-EugenioRenna/connect.git
```

Per un clone già esistente: `git submodule update --init --recursive`.

Implementazione iniziale della piattaforma centrale: dashboard React/TypeScript, API NestJS `/v1` con OpenAPI, PostgreSQL, Keycloak, Redis/BullMQ, adapter OpenWA, SDK e plugin WordPress. L’originale `EULAB_Admin_Anteprima_v0.2.html` è conservato integralmente; CSS, palette e struttura della nuova dashboard derivano dal riferimento approvato. Nessun dato dimostrativo viene inserito nel database di esercizio.

Incremento **applicato ad API e web locali; flusso MFA ancora da attivare e collaudare**: redirect app → SSO → app con esito strutturato, notifiche personali, SMTP, interfaccia sicurezza e provider MFA email/app con dispositivi attendibili. [Stato, attivazione e verifiche mancanti](docs/SICUREZZA-MFA-NOTIFICHE.md).

## Revisione admin del 19 ottobre 2026

Sorgenti aggiornati per navigazione raggruppata, CRUD, conversazioni WhatsApp, filtri audit e timeout SSO/SDK. **Applicati allo stack locale**. Il nuovo flusso WordPress è collaudato con Keycloak e WordPress reali, come descritto in [WORDPRESS-ACCESSO.md](docs/WORDPRESS-ACCESSO.md). I dettagli della revisione precedente sono in [ADMIN-2026-10-19.md](docs/ADMIN-2026-10-19.md).

Logo condiviso: sostituire `assets/brand/logo.svg`, poi `npm run brand:sync` (automatico anche in build/dev). Il file attuale è un segnaposto.

## Avviare

Con il file `.env` configurato (variabili in `.env.example`), basta Docker; npm e Node sul computer non sono richiesti:

```sh
docker compose up
```

L'avvio costruisce le immagini mancanti, applica le migrazioni, attende Keycloak e completa il servizio `bootstrap` prima di avviare API e runner. Il bootstrap crea l'admin iniziale e il servizio identità, configura i callback locali e conserva utenti, password e profili già esistenti. Non sono necessari comandi di inizializzazione dopo `up`.

Per la produzione, con `.env.production` e ingress già configurati, usare `./compose up`: il wrapper seleziona automaticamente l'overlay produzione. `docker compose up` usa lo sviluppo. Sono disponibili anche `./compose up -prod` e `./compose up -dev`; aggiungere `-d` per l'avvio in background. I due ambienti usano progetti e volumi distinti.

Dashboard: **http://localhost:8088**. Keycloak: **http://localhost:8080**. OpenAPI: **http://localhost:8088/v1/docs**.

La dashboard locale supporta anche `http://127.0.0.1:8088/`. Il bootstrap aggiorna i callback di un realm locale già esistente senza reimportarlo.

| Accesso | Credenziali locali in `.env` |
|---|---|
| Connect e gestione clienti/app | `EULAB_ADMIN_USERNAME` + `EULAB_ADMIN_PASSWORD` |
| Console Keycloak, realm `master` | `KEYCLOAK_ADMIN` + `KEYCLOAK_ADMIN_PASSWORD` |

La console di gestione Keycloak è su http://localhost:8080/admin/master/console/. Gli utenti applicativi Admin/Cliente appartengono al realm `eulab`.

L’amministratore iniziale viene creato automaticamente da Compose usando nome utente, nome, email e password di `.env` (`EULAB_ADMIN_*`). È un utente dello stesso realm `eulab` usato dai clienti. I valori del file ambiente inizializzano l'account: modificarli dopo la creazione non reimposta password o profilo esistenti. In **Identità e accessi** si creano e modificano gli utenti SSO, scegliendo il tipo **Admin** o **Cliente**. Il tipo Admin concede il pannello amministrativo; i cambi di tipo revocano le sessioni precedenti. Il bootstrap del master realm rimane separato. Conservare i segreti solo nei file ambiente, con permessi 0600. [Istruzioni operative](docs/OPERAZIONI.md).

## Collegare un’applicazione

1. Creare il cliente dalla dashboard.
2. **Applicazioni → Aggiungi app**: nome, dominio, descrizione, cliente, webapp/WordPress, eventuale sottocartella e URL di fallback. L’operazione registra applicazione e installazione nella stessa transazione.
3. Conservare la credenziale server mostrata una sola volta. Il fallback omesso diventa `<dominio><sottocartella>/eulab/connect/functions`; l’SDK aggiunge la chiave della funzione.
4. Esporre la matrice versionata con GET dall’app o dal plugin; Connect acquisisce automaticamente l’URL. Le nuove funzioni richiedono abilitazione e assegnazione esplicite. Vedi [funzioni, fallback e sessioni](docs/FUNZIONI-E-SESSIONI.md).
5. Configurare acquisto, abilitazione, scadenza, ruoli, appartenenze e collegamento esplicito tra subject Keycloak e ID utente locale. Le app esistenti possono inizializzare una nuova identità con la password appena verificata localmente tramite `mirrorUser({initialPassword})`: Connect la inoltra al provider e non la conserva. Nessuna identità viene collegata tramite uguaglianza dell’email. Il titolare può gestire la squadra con le API `/v1/team`, sempre entro cliente, applicazione, licenza e propria delega; le operazioni di modifica richiedono `team.manage`.
6. Per applicazioni con account locali (ALORA) usare il contratto di **attivazione assistita e migrazione obbligatoria**: la sorgente backend registra il deployment prima dell’app, invia la richiesta con la password verificata localmente e l’Admin EULAB esegue la pratica da **Attivazioni e migrazioni**. La password resta cifrata con TTL e viene cancellata alla conclusione; nessun accesso locale alternativo e nessuna unione per email. [Contratto, endpoint, configurazione e limiti](docs/ATTIVAZIONE-MIGRAZIONE.md).
7. Per WordPress, configurare il codice monouso nel file locale del plugin `pairing.local.php`: associazione automatica, nessuna pagina Impostazioni. In **Applicazioni → Siti WordPress → Utenti e accesso**, l’Admin Connect vede e filtra gli utenti sincronizzati e sceglie **Accedi come**. Il plugin apre l’account locale scelto con i suoi permessi, senza creare account tecnici e senza richiedere collegamenti SSO personali agli utenti WordPress. [Flusso e configurazione attuali](docs/WORDPRESS-ACCESSO.md).
8. Per le installazioni web/SDK, in **Installazioni → Utenti e accesso** l’Admin sceglie un profilo locale collegato e **Accedi come**. Connect emette un ticket monouso vincolato all’utente; l’app apre una sessione per quel profilo senza creare account. Il Technician mantiene l’accesso tecnico generico. [Contratto consumer](docs/ACCESSO-PROFILO-APP.md).


Un’applicazione può avere altre installazioni dalla sezione Installazioni. L’URL autorizzato è un’origine esatta (`https://dominio`, con porta se necessaria); la sottocartella è separata. Il fallback deve restare sulla stessa origine.

## Autorizzazioni

Il backend verifica a ogni operazione: installazione attiva, identità e appartenenza abilitate, collegamento locale esplicito, licenza attiva e non scaduta, funzione acquistata/abilitata, permesso assegnato e attivo nel catalogo. I job di invio ricontrollano token, sessione e autorizzazioni prima di chiamare OpenWA. Nessun esito positivo è ricavato dalla sola visibilità di un controllo UI.

JWT: firma RS256, issuer e audience `connect-api`; introspezione Keycloak a ogni richiesta per le revoche. Credenziali installazione: hash SHA-256 di segreti casuali di 256 bit. Token differiti e segreti webhook: AES-256-GCM. Le mutazioni PostgreSQL registrano audit nella stessa transazione dei dati; le operazioni sulle identità coinvolgono anche Keycloak, che è un servizio separato.

Gli ingressi browser/server dell’SDK sono separati: [guida integrazioni](docs/INTEGRAZIONI.md).

## WhatsApp e continuità dello storico

OpenWAUnlocked **1.0.0** in container privato, tramite i pacchetti `@eulab/openwaunlocked-core`, `@eulab/openwaunlocked-client` e `@eulab/openwaunlocked-driver-puppeteer`. Il QR viene recuperato tramite API autenticata nel contesto dell’installazione. Un indice PostgreSQL impedisce due sessioni aperte per lo stesso numero nell’intera piattaforma; lease Redis e code per runner identificano il proprietario.

**Specifica aggiornata:** l’archivio è identificato da **installazione/dominio + numero**. Una riconnessione dello stesso numero alla stessa installazione riaggancia l’archivio e deduplica lo storico sincronizzato. Su un altro dominio/installazione nasce un archivio separato: lo storico precedente rimane al dominio precedente. I tentativi di connessione sono distinti dall’archivio.

La disconnessione esplicita cancella il profilo di autenticazione di quella sessione, preserva l’archivio e annulla gli invii ancora in coda. Il logout remoto viene tentato se il client è disponibile; il suo esito è registrato separatamente e non viene inventato in caso di client già scaduto.

[Guida a compositore, verifica senza invio, SDK e recupero allegati](docs/WHATSAPP-MESSAGGI.md). [Bot IVR configurabile dalle app via SDK e laboratorio admin](docs/WHATSAPP-BOT-SDK.md). [WebSocket e SDK](docs/WHATSAPP-REALTIME.md).

Sono presenti adapter e API per testo, immagini, documenti PDF, audio, video, sondaggi, conversazioni, storico, eventi, stato, invio di prova e disconnessione. Il catalogo dell’app deve dichiarare `whatsapp.read`, `whatsapp.send`, `whatsapp.manage`, poi l’admin deve abilitare e assegnare esplicitamente i diritti.

Pulsanti multipli e liste sono disponibili tramite SDK e compositore admin, senza licenza provider. I menu IVR producono pulsanti con ID stabili; lo stesso percorso espone prompt vocali e accetta trascrizioni/DTMF per il futuro agente. Il pannello Chiamate WhatsApp mostra Coming soon. Il collaudo su telefoni reali resta distinto dalle verifiche automatiche. [Nuove API e SDK 0.8.0](docs/OPENWAUNLOCKED-0.8.0.md).

La sincronizzazione mostra stato, conteggio e limite esplicito: importa quanto WhatsApp rende disponibile, senza promettere uno storico completo. Media scaduti vengono segnalati come non disponibili. Messaggi e allegati sono caricati separatamente; lo storico ha pagine da 50 elementi.

Gli invii richiedono `Idempotency-Key`: stessa chiave e stesso payload restituiscono lo stesso record; payload diverso viene rifiutato. Se il provider può avere accettato un invio durante un crash, lo stato è `uncertain` e non si reinvia automaticamente. Il trasporto WhatsApp non offre una transazione condivisa con PostgreSQL: non viene promessa consegna exactly-once.

Webhook: HMAC-SHA256 sul corpo originale, timestamp, ID evento stabile, retry esponenziale, deduplicazione degli eventi ricevuti e registro consegne. Il destinatario deve registrare gli ID già elaborati. HTTPS pubblico, DNS risolto e fissato alla connessione, redirect non seguiti, destinazioni private/IPv6 rifiutate.

## Verifiche

```
npm test
npm run build
npm run infra:check
node scripts/verify-ui.mjs
```

I test automatici usano PostgreSQL WASM (PGlite) con lo schema SQL reale e le API NestJS in processo. Il provider OIDC è simulato con JWT realmente firmati: **non sostituisce il collaudo di Keycloak reale**. L’iniezione HTTP permette di verificare router, guard, validazione e controller senza aprire porte nel sandbox.

[Stato verifiche e lavoro operativo restante](docs/VERIFICHE.md). L’obiettivo **50–500 sessioni** resta da misurare sui server EULab. `scripts/capacity-report.mjs` raccoglie una fotografia SQL senza creare sessioni, inventare tempi o dichiarare il target raggiunto.

## Produzione predisposta

Dominio `https://auth.eulab.cloud`, pannello `/admin/`, SSO `/sso/`. Ingresso attraverso Cloudflare Tunnel e Nginx Proxy Manager esistenti, con NPM su un altro server. Nessun deploy eseguito. Vedi [configurazione produzione](docs/PRODUZIONE.md) e [integrazione di un’app esistente](docs/APP-ESISTENTE-CONNECT.md).

## Ambienti e comandi

[Guida unica dev, produzione, SMTP e comandi di verifica](docs/AMBIENTI-E-COMANDI.md). `npm run env:check` controlla entrambi i file ambiente senza stampare segreti o avviare servizi. La gestione MFA per persona è in **Utenti e accessi → Sicurezza e preferenze**; SMTP e durata SSO sono in **Impostazioni accesso**.

## SDK: riferimento pubblico

Il pacchetto ufficiale è [@eulab/connect su npm](https://www.npmjs.com/package/@eulab/connect); il codice è in [packages/sdk](./packages/sdk) e il contratto applicativo in [INTEGRATION.md](./packages/sdk/INTEGRATION.md). La candidata locale 0.10.0 resta distinta dall’ultima versione pubblicata: la sua pubblicazione non è stata eseguita durante l’integrazione ALORA. Verificare il registry prima di sostituire il tarball consumer con una versione npm esatta.


### Automazioni — aggiornamento locale schema 015

API, runner e migratore sono aggiornati localmente al contratto SDK 0.12.0-rc.2. Backup, confronto dati, prove isolate e limiti sono nel [resoconto del passaggio](docs/LOCAL-AUTOMATIONS-RUNTIME-015.md). Nessun account o messaggio reale modificato e nessuna pubblicazione eseguita; dispositivo e webhook pubblico restano da accettare.
