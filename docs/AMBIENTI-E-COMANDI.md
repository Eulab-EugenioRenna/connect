# Ambienti e comandi

## File ambiente

| File | Uso | Generazione |
| --- | --- | --- |
| `.env` | Stack locale Compose, SMTP locale, credenziali QA opzionali | `node scripts/init-env.mjs` |
| `.env.production` | Stack remoto isolato, HTTPS `/admin/` e `/sso/` | `node scripts/init-production-env.mjs` |
| `.env.example` | Elenco pubblico dei parametri, senza segreti | Riferimento per compilazione |

I generatori creano i file solo se assenti, con permessi 0600, senza sovrascrivere credenziali esistenti. I due file sono esclusi da Git e dal contesto Docker. I valori SMTP vengono inoltrati solo all’API. Keycloak usa la configurazione sincronizzata nel realm; cambiare il file ambiente richiede ricreare l’API e ripetere la sincronizzazione. Non inserire password nei comandi, nelle guide o nei file pubblici.

`SMTP_HOST` è il solo hostname, `SMTP_FROM` il mittente email, `SMTP_USER` e `SMTP_PASSWORD` le credenziali del trasporto. Usare `SMTP_PORT=587` con `SMTP_SECURITY=starttls`, oppure 465 con `tls`, secondo il server. I due campi credenziali devono essere entrambi presenti oppure entrambi vuoti per un relay senza autenticazione. Il certificato TLS viene verificato.

## Sviluppo locale

Richiesto Node 22 e Docker Compose con supporto `!reset`/`!override`.

```sh
npm ci
node scripts/init-env.mjs
npm run infra:check
docker compose up -d --build
```

Dashboard `http://localhost:8088`, SSO `http://localhost:8080`, API/OpenAPI `http://localhost:8088/v1/docs`. Configurare l’amministratore come indicato in [OPERAZIONI.md](OPERAZIONI.md). Per la sola UI con aggiornamento automatico: `npm run dev` su porta 5173, con API raggiungibile su `127.0.0.1:3000`. Il proxy Vite punta a questa porta: l’API dello stack standard è interna e non viene esposta automaticamente sulla 3000.

`npm run dev:api`, `npm run dev:runner` e `npm run db:migrate` caricano `.env`. Fuori da Compose servono anche `DATABASE_URL`, `REDIS_URL`, `OIDC_ISSUER`, `OIDC_INTERNAL_ISSUER`, `OIDC_JWKS_URL` per servizi raggiungibili dall’host. Gli hostname `postgres`, `redis`, `keycloak` appartengono alla rete Docker. Le variabili già esportate nel processo prevalgono sul file. Non usare questi comandi con URL di produzione per il normale sviluppo.

Il collaudo WordPress usa `node scripts/init-qa-env.mjs` e l’overlay `infra/compose.qa.yaml`; il secondo runner usa `infra/compose.runner-2.yaml`. Questi overlay sono esclusi dalla produzione.

## SMTP e MFA

```sh
# Dopo aver compilato .env e compilato il progetto:
npm run smtp:check
# Verifica TLS/autenticazione e sincronizza il realm usando l’admin master:
npm run smtp:sync
```

Questi comandi non inviano email. L’alternativa amministrativa è **Impostazioni accesso → Sincronizza SMTP con SSO**; l’API deve essere stata ricreata con i valori aggiornati. Il comando CLI richiede che Keycloak sia raggiungibile tramite `PUBLIC_KEYCLOAK_URL` o `KEYCLOAK_INTERNAL_URL` e usa le credenziali master del file locale, senza stamparle. `smtp:check` non modifica Keycloak; `smtp:sync` non attiva MFA.

```sh
npm run security:profile # Dichiara la preferenza nel profilo Keycloak
npm run security:prepare
# Solo dopo installazione e collaudo del provider e sincronizzazione SMTP:
npm run security:activate
```

L’attivazione cambia il flusso di login dell’intero realm. Non viene eseguita dal controllo globale. [Procedura e limiti del collaudo MFA](SICUREZZA-MFA-NOTIFICHE.md).

Per persona: **Utenti e accessi → Sicurezza e preferenze**. L’admin vede app collegate, email verificata e dispositivi attendibili, sceglie il metodo preferito e revoca le credenziali selezionate. Configurazione QR e verifica email sono nell’SDK/login. La rimozione di un’app revoca anche i dispositivi attendibili e tenta la chiusura delle sessioni SSO. Nessuna opzione disabilita il secondo fattore.

## Produzione

```sh
node scripts/prepare-production-config.mjs
node scripts/init-production-env.mjs
npm run infra:check:prod
npm run env:check
```

Compilare SMTP, IP privato Connect e CIDR di NPM nel file produzione. Il controllo segnala i valori loopback iniziali come preparazione incompleta, pur accettandoli per la validazione locale. Per operare sugli script da host con il file produzione usare `EULAB_ENV_FILE=.env.production` negli script che lo supportano; per SMTP: `node --env-file=.env.production scripts/check-smtp.mjs` (aggiungere `--sync` per sincronizzare). Non usare i comandi SMTP predefiniti `.env` sul server produzione.

Per avvio e bootstrap usare esattamente gli overlay e i comandi di [PRODUZIONE.md](PRODUZIONE.md). Il progetto `eulab-connect-production` usa volumi distinti da `eulab-connect`. Nessun deploy, DNS o certificato viene creato dai controlli qui elencati.

## Verifica globale

```sh
npm run env:check
npm run verify
npm run infra:check:prod
npm run test:mfa:core
```

`env:check` legge entrambi gli env, controlla chiavi, duplicati, permessi, parametri SMTP e configurazioni Compose renderizzate senza stamparne i segreti; verifica isolamento produzione e inoltro SMTP all’API. Non prova il trasporto SMTP. `verify` esegue test, build di API/SDK/web/demo/installer WordPress e controllo Compose locale. Il nucleo Java richiede JDK 21; compilare l’intero provider richiede Maven o la build Docker Keycloak.

La verifica UI (`npm run verify:ui`) usa un browser e provider simulato. Il collaudo reale MFA richiede Keycloak con il provider installato, SMTP funzionante e HTTPS per i dispositivi attendibili. Gli esiti del controllo corrente sono in [CHECK-GLOBALE-2026-10-19.md](CHECK-GLOBALE-2026-10-19.md).
