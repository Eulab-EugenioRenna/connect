# Workshop BFF

Seconda applicazione autonoma, senza import ALORA, Nest o Angular. Un solo `ConnectApplication` e quattro adattatori: credenziali legacy, provisioning, persistenza PostgreSQL, restrizioni sui progetti. Nessun grant, PKCE, cifratura o macchina degli stati è implementato qui.

1. Estrarre il tarball SDK e copiare questa cartella fuori dal repository. Installare con `npm install @eulab/connect@/percorso/eulab-connect-0.10.0.tgz pg@8.23.0` (sostituisce il riferimento relativo di esempio).
2. Copiare `.env.example` in `.env`, impostare una **banca dati dedicata**, credenziale tecnica presenter e segreti secondo [la guida](../../INTEGRATION.md). Generare la chiave con `openssl rand -hex 32` e salvarla solo in `.env`.
3. `npm run migrate`; facoltativamente impostare email/password legacy in `.env` e usare `npm run seed`. Il seed non sovrascrive account o hash esistenti. Nessun account admin o licenza viene creato.
4. `npm run check` controlla discovery e sorgente, senza scritture. `npm start`, aprire `http://127.0.0.1:55179`.
5. Accesso legacy → consenso → richiesta in attesa. L’amministratore Connect approva piano, catalogo e assegnazioni, poi esegue la pratica. Nel piano sceglie/crea app, cliente e installazione e configura il client SSO. Usare **Sincronizza configurazione approvata** prima del successivo accesso: la configurazione resta cifrata sul backend, poi si apre SSO. Prima dell’approvazione non servono issuer/clientId o sorgente registrata. Per `choose_connect_password`, ripetere la prova locale e scegliere una password Connect diversa; l’esecuzione successiva rimane esplicita in Connect.
6. Se si adotta una sorgente già registrata, usare invece CONNECT_SOURCE_SECRET e configurazione OIDC statica: entrambi i percorsi restano supportati.
7. Login SSO → callback BFF → handoff → cookie HttpOnly → progetti. Licenza e restrizioni per azienda vengono verificate prima della query. Refresh/logout sono chiamate SDK.

Il BFF limita il body e controlla Host/Origin. In produzione usare TLS e un adattatore HTTP per il proprio proxy verificato; rimuovere l’opt-in HTTP locale. Il demo usa intenzionalmente una sola origine loopback. Non è un sistema di amministrazione o una UI di produzione.
