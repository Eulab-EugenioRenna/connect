# Produzione: connect.eulab.cloud e auth.eulab.cloud

Deploy con il profilo P1 del modello EULAB (§14): immagini runtime su GHCR costruite da GitHub Actions, nessun sorgente né build sul server. Server: container Proxmox LXC 123 `connect` (192.168.2.228), ingresso da Nginx Proxy Manager (LXC 103, 192.168.2.49).

## Indirizzi

| Servizio | URL pubblico |
| --- | --- |
| Pannello Connect | `https://connect.eulab.cloud/admin/` |
| API / SDK server | `https://connect.eulab.cloud` (endpoint `/v1/...`) |
| Issuer SSO SDK e WordPress | `https://auth.eulab.cloud/sso/realms/eulab` |
| Callback e logout del pannello | `https://connect.eulab.cloud/admin/` |
| Installer WordPress | `https://connect.eulab.cloud/admin/downloads/euconnect.php` |

La console di amministrazione di Keycloak (`/sso/admin/`) non è pubblica: Connect la usa dalla rete interna (`http://keycloak:8080/sso`).

## Deploy (profilo P1)

- `deploy/compose.production.yml`: solo immagini `ghcr.io/eulab-eugeniorenna/connect-{api,bootstrap,migrate,runner,web,keycloak}:<commit>`. Realm, tema e `config.js` sono dentro le immagini.
- `/srv/connect/.env.production` (600) si crea sul server con `deploy/scripts/init-env.sh <ip> <cidr-npm> <email-admin>`: i segreti nascono lì e non vengono stampati. Conservare a parte `DATA_ENCRYPTION_KEY`.
- `deploy/scripts/deploy.sh <commit>`: controlli sul file ambiente, pull, backup (`backup.sh`: dump del database con lo schema Keycloak e profili WhatsApp), avvio, controllo di salute interno su `/admin/`, `/v1/health` e discovery OIDC.
- `.github/workflows/deploy.yml`: su `main` costruisce le immagini; il job `production` gira sul runner self-hosted `connect-production` dopo l'approvazione nell'environment `production`, ed è spento finché `CONNECT_DEPLOY_ENABLED` non vale `true`. Ritorno indietro: `workflow_dispatch` con il tag precedente (`/srv/connect/previous-tag`).

Le sezioni che seguono descrivono la preparazione storica dal pacchetto sorgente: il percorso corrente è quello sopra.

## Ingresso esistente: Cloudflare Tunnel e NPM remoto

Non viene installato Caddy né un altro servizio di certificati. Il percorso previsto è Cloudflare Tunnel → Nginx Proxy Manager esistente → IP privato del server Connect, porta configurata. Il container web di Connect espone l’unico ingresso HTTP interno e smista `/admin/`, `/sso/` e `/v1/`; non occorrono regole di percorso aggiuntive in NPM. `/` e `/admin` reindirizzano a `/admin/`.

Quando saranno noti i server, configurare in `.env.production`:

- `CONNECT_BIND_IP`: l’IP privato/VPN del server Connect su cui esporre l’ingresso.
- `CONNECT_HTTP_PORT`: porta da impostare nel Proxy Host NPM, predefinita `8088`.
- `NPM_TRUSTED_CIDR`: IP sorgente o CIDR del server NPM remoto. L’ingresso rifiuta le altre sorgenti.

I valori iniziali limitati a loopback sono intenzionali: vanno sostituiti con gli IP reali prima dell’avvio remoto. Tra NPM e Connect serve connettività privata/VPN o un canale protetto equivalente; non pubblicare l’origine HTTP indiscriminatamente su Internet.

In NPM il Proxy Host `auth.eulab.cloud` inoltra via HTTP a `CONNECT_BIND_IP:CONNECT_HTTP_PORT`, mantenendo l’host pubblico. Il tunnel Cloudflare esistente inoltra questo hostname a NPM secondo la sua configurazione attuale. TLS, certificati e tunnel rimangono gestiti dall’infrastruttura già presente.

Il gateway imposta l’origine HTTPS pubblica per Keycloak e conserva il prefisso `/sso/`. Keycloak usa un’immagine ottimizzata con `start --optimized`, senza pubblicare direttamente la porta `8080`. PostgreSQL e Redis rimangono interni. Riferimenti: [proxy Keycloak](https://www.keycloak.org/server/reverseproxy), [immagine ottimizzata](https://www.keycloak.org/server/containers).

## Preparazione locale

```sh
node scripts/prepare-production-config.mjs
node scripts/init-production-env.mjs
# Verifica senza avviare container, tunnel o certificati:
docker compose -f compose.yaml -f infra/compose.production.yaml --env-file .env.production config --quiet
```

`.env.production` è escluso dal versionamento, ha permessi 0600 e viene creato solo se assente. I segreti non vengono stampati e non si riutilizzano quelli del collaudo. `PUBLIC_CONNECT_URL`, issuer, hostname e base path sono già impostati per `auth.eulab.cloud`. Non combinare l’overlay produzione con gli overlay QA.

La build web produzione usa il target `web-production`, con asset, configurazione, logo e callback sotto `/admin/`. Il build locale normale mantiene i percorsi di sviluppo.

## Comandi futuri sul server, da eseguire solo al momento del deploy

Prima del primo avvio compilare gli IP sopra e configurare NPM/tunnel. Non copiare dati QA, account di prova o file `pairing.local.php` nei siti di produzione.

```sh
docker compose -f compose.yaml -f infra/compose.production.yaml --env-file .env.production up -d --build
# Equivalente abbreviato; il wrapper usa la produzione per default:
./compose up -d
```

Il servizio `bootstrap` incluso nell'immagine attende Keycloak, usa il prefisso interno `/sso`, configura l'admin e il servizio identità e allinea il callback del pannello. API e runner attendono il completamento del bootstrap. Gli account esistenti conservano password, ID e profili; nessun file ambiente o sorgente deve essere montato per inizializzarli. L’import JSON da solo non aggiorna un realm già importato. Per un database preesistente preservare nome progetto e volumi e fare un backup prima di modificare la configurazione; non usare reset o cancellazione volumi. Il nome progetto predefinito del nuovo stack produzione è `eulab-connect-production`. Il comando nativo `docker compose up` mantiene lo sviluppo come ambiente predefinito.

Il deploy remoto, la risoluzione DNS, il tunnel, l’HTTPS pubblico e il login SSO sul dominio definitivo non sono ancora stati eseguiti o verificati.

## SMTP e sicurezza per persona

Gli env e i comandi sono riepilogati in [AMBIENTI-E-COMANDI.md](AMBIENTI-E-COMANDI.md). Compilare i parametri SMTP di `.env.production`, ricreare l’API e sincronizzare con SSO; i valori locali non vengono copiati automaticamente. Prima delle preferenze MFA configurare il campo del profilo con `scripts/setup-security-profile.mjs`, usando il file produzione e l’URL Keycloak con prefisso `/sso`. Configurazione profilo e SMTP non attivano il nuovo flusso MFA. [Esito del controllo globale](CHECK-GLOBALE-2026-10-19.md).

## Nuova macchina: pacchetto e avvio ripetibile

Prerequisiti: macchina Linux con Docker Engine e plugin Compose con supporto `!reset` e `!override` ([almeno 2.24.4](https://docs.docker.com/reference/compose-file/merge/)), Node.js 22.22 o successivo della linea 22 per gli script operativi, accesso ai registry Docker/npm/Maven e a WhatsApp. Il runner installa Chromium per l’architettura del server; non copia browser o `node_modules` della macchina di sviluppo. Il deploy corrente è configurato per `auth.eulab.cloud` e l’ingresso descritto sopra.

Sul computer di preparazione:

```sh
npm ci
npm test
npm run build
npm run package:production
```

Trasferire `dist/releases/eulab-connect-source.tar.gz` e il suo file `.sha256`. Il pacchetto usa un elenco esplicito dei sorgenti: non include `.env`, `.env.production`, `node_modules`, backup, profili WhatsApp, pairing locale WordPress, screenshot di collaudo, repository OpenWAUnlocked o build preesistenti. Verificare il checksum dopo il trasferimento. Il checksum identifica l’archivio e non sostituisce un canale di trasferimento affidabile.

Sul nuovo host, per un’installazione vuota:

```sh
sha256sum -c eulab-connect-source.tar.gz.sha256
mkdir -p connect
cd connect
tar -xzf ../eulab-connect-source.tar.gz --no-same-owner
node scripts/init-production-env.mjs
chmod 600 .env.production
# Compilare IP privato, CIDR dell’ingresso, SMTP e identità admin nel file privato.
npm run deploy:production
npm run deploy:production -- --apply
```

`deploy:production` senza flag esegue solo il preflight: verifica segreti, origine/issuer, Docker, isolamento dei servizi, volumi e configurazione di produzione. Non richiede `.env` di sviluppo. Se NPM risiede sulla stessa macchina e comunica via loopback, aggiungere `--local-ingress` sia al controllo sia all’avvio. Il flag deve corrispondere alla topologia reale; non serve per un NPM remoto.

`--apply` costruisce le immagini dai sorgenti e lockfile, attende PostgreSQL/Redis, esegue le migrazioni 001–011 e avvia i servizi dopo il bootstrap amministratore/servizio identità automatico. Non azzera database o volumi e non associa un numero WhatsApp. Completare quindi la configurazione SMTP e sicurezza e le verifiche pubbliche. Per un aggiornamento fare prima un backup coerente di database e volumi usando la configurazione di produzione e conservare separatamente la chiave; non eseguire gli script di backup/ripristino locali sul progetto di produzione senza verificarne il contesto Compose.

## Accettazione prima dell’apertura agli utenti

1. Dal dominio pubblico verificare `/admin/`, `/v1/health`, discovery OIDC sotto `/sso`, login/logout e revoca accessi, callback delle app e WebSocket. Non esporre porte database/Redis/Keycloak.
2. Configurare e collaudare SMTP e il flusso MFA scelto, recupero accesso e notifiche. I test locali non confermano il recapito dal nuovo host.
3. Associare WhatsApp con un nuovo QR OpenWAUnlocked; provare invio/ricezione con un destinatario autorizzato, pulsanti multipli, clic di risposta, IVR completo, media, disconnessione e ripresa dopo riavvio. Non ripetere automaticamente invii incerti.
4. Verificare backup e ripristino in un ambiente isolato e indipendente, usando la stessa chiave cifrante. Misurare capacità e risorse sul nuovo host prima di aumentare i runner.

Il pannello Chiamate WhatsApp resta **Coming soon**. La simulazione vocale e le sessioni IVR dell’SDK preparano il futuro agente; non certificano telefonia o audio AI in produzione. Build, test automatici e preflight sono evidenze distinte dall’accettazione sul nuovo server.

## Collaudo automatizzato del primo avvio

Dopo aver costruito le immagini di produzione, `npm run verify:production` crea un progetto Compose temporaneo con database, Redis, credenziali e volumi nuovi. Non usa i segreti o i dati dello stack attuale. Verifica le migrazioni anche al secondo avvio, discovery OIDC con issuer `/sso`, bootstrap admin, health via Nginx, asset `/admin/` e heartbeat del runner; rimuove i propri container e volumi al termine. Richiede risorse disponibili per uno stack aggiuntivo. Non associa WhatsApp e non invia email o chiamate.

Il prefisso `KC_HTTP_RELATIVE_PATH=/sso` è fissato durante la costruzione dell’immagine Keycloak, oltre che al runtime. Con `start --optimized` deve coincidere con il valore persistito dalla build.

`KC_HOSTNAME` è impostato a `https://auth.eulab.cloud/sso`, includendo il percorso pubblico: la discovery deve restituire esattamente `https://auth.eulab.cloud/sso/realms/eulab`. [Riferimento hostname Keycloak](https://www.keycloak.org/server/hostname).


## Immagini runtime ridotte

La build Docker separa gli input e le cache di backend, frontend e dipendenze. Il backend viene prima compilato con TypeScript, conservando i metadati necessari a Nest, poi raccolto in tre bundle eseguibili: `api.mjs`, `runner.mjs` e `migrate.mjs`. Le immagini finali non copiano `apps/`, `packages/`, test, documentazione, sorgenti TypeScript, source map o manifest del progetto. Node esegue JavaScript compilato: non si tratta di un binario nativo autonomo.

| Immagine | Contenuto applicativo |
| --- | --- |
| API | Bundle API e dipendenze di produzione |
| Migrazioni | Bundle migrazioni, dipendenze di produzione e SQL `infra/postgres` |
| Bootstrap | Bundle inizializzazione SSO e dipendenze di produzione; nessun sorgente o file ambiente |
| Runner | Bundle runner, dipendenze di produzione, pacchetti OpenWAUnlocked, asset WhatsApp e Chromium |
| Web | Nginx e asset statici compilati, inclusi gli installer WordPress scaricabili |

Gli stage Node finali copiano soltanto l'eseguibile Node nella base Debian e girano con utente `node`, UID 1000. npm, npx, Yarn, compilatore TypeScript e strumenti di build/test rimangono negli stage intermedi. Le dipendenze vengono installate dai lockfile, senza dipendenze di sviluppo, e ripulite da dichiarazioni TypeScript, mappe, esempi e documentazione; moduli eseguibili, asset e licenze restano disponibili. Il provider esclude anche i peer non utilizzati a runtime, compreso il compilatore TypeScript. API, migrazioni e runner condividono i layer delle dipendenze server. Chromium rimane soltanto nel runner; i profili persistono nel volume `/profiles`.

Per verificare contenuto, utente, import dei moduli provider, avvio Chromium senza rete e dimensioni effettive dopo la build di produzione:

```sh
docker compose -f compose.yaml -f infra/compose.production.yaml --env-file .env.production build
npm run verify:images
npm run verify:production
```

`verify:images` usa i nomi immagini generati dal progetto `eulab-connect-production`; un altro prefisso può essere passato come argomento. Non associa WhatsApp e non invia messaggi. `verify:production` verifica poi il primo avvio completo in uno stack temporaneo separato.

Verifica del 21 ottobre 2026: build applicativa e 72 test passati; compilazione ripetuta in directory temporanee contenenti soltanto gli input degli stage Docker. In un'installazione runtime isolata su macOS, le dipendenze server passano da 41.012.492 a 19.236.683 byte dopo la pulizia; quelle provider da 132.291.410 a 66.468.760 byte. L'API compilata si avvia e pubblica gli 88 percorsi OpenAPI, e i moduli provider si caricano senza gli strumenti di sviluppo. Queste misure riguardano i file delle dipendenze, non le immagini Linux.

Il collaudo e le dimensioni delle nuove immagini restano da verificare: il backend Docker Desktop locale si arresta con `initializing configurator: user: unknown userid 501`. Il precedente rapporto `production-runtime.json` documenta le immagini costruite prima di questa ottimizzazione e non certifica il nuovo Dockerfile. Le verifiche correnti sono distinte in `docs/verification/openwaunlocked/docker-runtime.json`.
