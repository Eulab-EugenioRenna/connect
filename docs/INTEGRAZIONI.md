# Integrazioni SDK e WordPress

[Modello, matrice, fallback di login e sessioni](FUNZIONI-E-SESSIONI.md).

## SDK

Per applicazioni già in produzione: [copia dell’identità con `mirrorUser` e login Connect separato](APP-ESISTENTE-CONNECT.md). Per il dominio definitivo: [produzione con Cloudflare Tunnel e NPM remoto](PRODUZIONE.md).

Compilare con `npm run build`; il pacchetto è in `packages/sdk`, con export separati `@eulab/connect/browser` e `@eulab/connect/server` e dichiarazioni TypeScript. Per preparare i tarball npm del Connect SDK e di tutti i pacchetti pubblicabili OpenWAUnlocked, eseguire `npm run package:npm`, poi `npm run verify:npm`. Vedere [bundle npm](RILASCIO-NPM.md). La preparazione locale non pubblica i pacchetti nel registry.

```ts
// Solo browser. Nessuna credenziale server.
import {ConnectBrowser} from '@eulab/connect/browser';
const connect = new ConnectBrowser({
  apiUrl: 'https://connect.example',
  issuer: 'https://sso.example/realms/eulab',
  clientId: 'client-registrato-in-keycloak',
  redirectUri: location.origin + '/',
  installationId: 'UUID-assegnato',
});
// All’avvio e sul callback: PKCE, ripristino e rinnovo della sessione.
if (await connect.init({loginRequired:true})) {
  const context = await connect.context();
  const wa = connect.whatsapp(); // usa installationId della configurazione
  const sessions = await wa.sessions();
  const active = sessions.find(s => s.state === 'connected' && !s.closed_at);
  if (active) {
    await wa.sendText(active.id, '+39 333 1234567', 'Messaggio autorizzato', chiavePersistita);
  }
}
const url = connect.functionUrl('whatsapp');
// Default: https://<origine-attuale>/eulab/connect/functions/whatsapp
```

La versione locale **0.5.1** rinnova il token prima delle richieste e ripristina la sessione nella stessa scheda tramite `sessionStorage`, rispettando i timeout Keycloak e le revoche. `init({loginRequired:true})` avvia il redirect SSO se serve; `init()` restituisce solo lo stato. `logout()` chiude la sessione SSO. I segreti installazione restano esclusivamente sul server. I timeout si amministrano in **Identità e accessi → Configurazione SSO**; la sincronizzazione fa ereditare i timeout del realm alle app, senza modificare i callback autorizzati.

`whatsapp()` espone gli stessi metodi su browser e server (sul server richiede il token utente): `sessions`, `connect`, `qr`, `send`, `sendText`, `reconnect`, `disconnect`, `archives`, `conversations`, `messages`, `media`, `deleteConnection`, `deleteArchive`. Questi ultimi due cancellano esplicitamente lo storico: `removed=false, state=disconnecting` indica che il runner deve ancora completare la rimozione dell’autenticazione e la pulizia. `disconnect` conserva lo storico. Per il formato dei numeri utilizzare sempre il prefisso internazionale; gli ID tecnici `@c.us` e `@g.us` già disponibili rimangono accettati.

`functionFallbackUrl` permette di usare il fallback configurato nell’installazione; `functionUrl(key, path)` può indirizzare una funzione a un percorso specifico della stessa origine. Il risultato è una destinazione: l’applicazione deve montare quel percorso e applicare il controllo backend alla sua operazione, come nell’app dimostrativa. L’SDK non può creare automaticamente rotte nel framework ospitante.

```ts
// Solo server: leggere valori da .env o dal secret manager, mai da bundle browser.
import {ConnectServer} from '@eulab/connect/server';
const connect = new ConnectServer({
  apiUrl: process.env.EULAB_CONNECT_URL!,
  installationId: process.env.EULAB_INSTALLATION_ID!,
  secret: process.env.EULAB_INSTALLATION_SECRET!,
  domain: process.env.APP_ORIGIN!,
});
// Nel GET dell’app a /.well-known/eulab-connect.json:
// return functionsResponse(defineFunctions({appId:'mia-app', version:1, functions:[
//   {key:'whatsapp.send',name:'Invia messaggi'},
// ]}));
await connect.registerFunctions(); // Connect acquisisce la matrice con GET
const result = await connect.authorize(accessTokenUtente, 'whatsapp.send');
if (!result.allowed) throw new Error(result.reason);
await connect.whatsapp(accessTokenUtente).sendText(
  sessionId, '+39 333 1234567', 'Messaggio autorizzato', chiaveUnicaPersistitaPerOperazione,
);
```

Non generare una nuova chiave a ogni retry HTTP dello stesso invio. L’app deve conservarla con la propria operazione. Non passare un subject arbitrario al posto del token utente.

`ConnectServer.pair(apiUrl, code, domain)` consuma il codice monouso e ruota la credenziale. `redeemTechnicalTicket(ticket)` è destinato al callback server dell’applicazione: accettare esclusivamente ticket emessi per la propria installazione e creare una sessione tecnica locale distinta dagli utenti cliente. Il token restituito resta sul server, cifrato; verificare il contesto centrale sulle operazioni tecniche successive.

L’app dimostrativa si avvia con `npm run dev:demo` su `http://localhost:5174`. L’API deve essere avviata separatamente. Registrare quell’origine, un’identità cliente, il suo ID utente locale e i permessi prima del collaudo. È una dimostrazione dell’integrazione, senza un database applicativo locale di esempio.

## WordPress

Metodo attuale consigliato: [installer PHP unico da browser](WORDPRESS-INSTALLER.md), che installa soltanto EULab Connect come MU-plugin. Le istruzioni per il plugin ordinario sotto restano valide per installazioni esistenti.

Installare la directory `plugins/wordpress/eulab-connect` in `wp-content/plugins`, poi attivare il plugin. PHP >=8.1 con libsodium.

Configurare nel `wp-config.php` locale:

- `EULAB_CONNECT_API`: URL HTTPS delle API centrali.
- `EULAB_CONNECT_STORAGE_KEY`: chiave casuale di 32 byte, codificata base64, generata e conservata localmente.
- Facoltativi `EULAB_CONNECT_SSO_ENABLED=true` ed `EULAB_CONNECT_ISSUER`: abilitano il login clienti SSO.
- Se WordPress e Keycloak comunicano su rete Docker, `EULAB_CONNECT_INTERNAL_ISSUER` indica l’endpoint raggiungibile dal server per lo scambio token. L’issuer pubblico resta quello usato nel browser.

Il plugin non ha un pannello Impostazioni. Inserire il codice monouso di Connect nel file locale `pairing.local.php` (costante `EULAB_CONNECT_PAIRING_CODE`): l’associazione viene eseguita automaticamente, le credenziali sono cifrate nelle opzioni WordPress e non sono autoload. Il file del codice è escluso da Git e build Docker. Per il sito locale il codice è già stato configurato e consumato. [Configurazione e dettagli operativi](WORDPRESS-ACCESSO.md).

Dall’admin Connect: **Applicazioni → Siti WordPress → Utenti e accesso**. Qui si cercano e filtrano gli utenti locali per nome, username, email e ruolo e si sceglie **Accedi come**. Il plugin non crea account o ruoli tecnici: entra direttamente nell’account scelto, mantenendone i privilegi nativi. Sono selezionabili gli utenti locali reali del sito; i vecchi account tecnici sono esclusi. Il ticket è monouso, valido 60 secondi, vincolato all’installazione e all’ID selezionato; nessun ticket WordPress è emesso senza scelta dell’utente. Password e altre sessioni locali rimangono indipendenti. La sessione di accesso EULab dura al massimo cinque minuti ed è ricontrollata rispetto alla sessione centrale su ogni richiesta. Per scegliere un altro utente si torna all’admin Connect.

L’elenco è una directory esterna sincronizzata dal plugin, senza password. La UI mostra data e stato della sincronizzazione e consente di richiederne una nuova. Il cron del sito deve essere operativo; la richiesta non garantisce un aggiornamento istantaneo. Il plugin ricontrolla sempre l’utente locale prima del login, anche se l’elenco centrale è precedente all’ultima modifica del sito.

Collaudo reale attuale: `verification/wordpress-selected-user/result.json`. Gli screenshot e i risultati precedenti relativi all’account tecnico sono storici e non descrivono più il flusso corrente.

Per l’SSO clienti, registrare nel client pubblico Keycloak `connect-wordpress` il callback esatto `<home_url>/?eulab_sso_callback=1`, con PKCE S256 e audience `connect-api`. Non aggiungere wildcard generiche. Collegare esplicitamente il subject al valore numerico dell’utente locale. Il plugin non crea né unisce utenti cliente sulla base dell’email.

Il codice PHP dell’applicazione deve invocare `eulab_connect_require('whatsapp.send', eulab_connect_access_token())` prima dell’operazione protetta. `eulab_connect_can` consente di scegliere cosa mostrare nella UI; la protezione rimane nel codice server. Il plugin non può proteggere automaticamente tutte le azioni di plugin terzi: ogni azione dell’app deve usare il controllo appropriato.

## Webhook

Usare il corpo raw, senza deserializzarlo e serializzarlo nuovamente. Header: `X-EULab-Event-Id`, `X-EULab-Timestamp`, `X-EULab-Signature`. La firma è HMAC-SHA256 di `<timestamp>.<corpo-raw>`, esadecimale. `verifyWebhook` nell’ingresso server verifica firma e tolleranza di cinque minuti. Registrare l’ID in una tabella con indice univoco prima degli effetti locali; rispondere 2xx alle riconsegne già elaborate.

Per MFA con QR/codici email, dispositivi attendibili, SMTP, notifiche e il risultato strutturato del redirect SSO, vedi [Sicurezza, MFA e notifiche](SICUREZZA-MFA-NOTIFICHE.md). Le nuove funzioni richiedono migrazione 006 e attivazione del provider sul runtime.

## Inizializzazione in un service condiviso

L’SDK è importabile e indipendente dal framework. `ConnectBrowser` si può istanziare una sola volta nel service dell’app; tutti i componenti chiamano quell’istanza, senza ricrearla a ogni richiesta.

```ts
// services/connect.ts (solo browser)
import {ConnectBrowser, type BrowserConfig} from '@eulab/connect/browser';
export function createConnectService(config: BrowserConfig) {
  return new ConnectBrowser(config);
}
// L’app esporta una sola istanza con la propria configurazione:
// export const connectService = createConnectService(config);
```

Nel bootstrap dell’app si attende `connectService.init()`. Nei componenti si importa il service e si chiamano direttamente `connectService.permissions()`, `connectService.notifications()`, `connectService.configureMfa()` e gli altri metodi. `init()` restituisce `false` quando serve il login o l’accesso applicativo è negato; `init({loginRequired:true})` avvia il redirect quando manca la sessione. Anche più chiamate concorrenti a `init()` o `callback()` sulla stessa istanza condividono il ripristino/scambio OIDC: il codice di autorizzazione viene consumato una sola volta.

Nel backend, `ConnectServer` si può registrare come provider singleton del framework usando una factory con la configurazione installazione. Le chiamate relative agli utenti ricevono sempre il loro access token come parametro: il service server non conserva un bearer globale condiviso fra utenti. `ConnectBrowser` è invece uno stato per browser/sessione e non va usato come singleton di un server con più utenti.

## Check sessione e rinnovo token (SDK 0.5.1)

```ts
const valid = await connectService.checkSession();
const stop = connectService.watchSession(valid => {
  // true: rinnovo riuscito; false: sessione assente/revocata;
  // null: controllo non conclusivo per errore temporaneo.
}, 30_000);
// Allo smontaggio del service/root dell’app:
stop();
```

`checkSession()` esegue un refresh a ogni controllo, anche se l’access token è ancora fresco. Ripristina il refresh token dalla sessione della scheda quando serve e sostituisce quello conservato con il valore nuovo se restituito dal provider. I check concorrenti sulla stessa istanza condividono un solo rinnovo; le richieste API attendono il rinnovo in corso e usano il token aggiornato. Le altre richieste rinnovano soltanto in prossimità della scadenza, senza ripetere automaticamente mutazioni.

Il cookie SSO HttpOnly è verificato da Keycloak, non letto dall’SDK. Il refresh grant verifica la sessione server associata al refresh token; la sola presenza di un cookie non autorizza a generare token. Se manca il refresh token, `init({loginRequired:true})` passa per il redirect SSO e il cookie valido permette a Keycloak di restituire nuovi token. Per un tentativo senza interazione è disponibile `login({prompt:'none'})`, che ritorna un errore gestibile se il login è necessario. [Comportamento del provider](https://www.keycloak.org/securing-apps/javascript-adapter).

Access token in memoria; refresh token e ID token nella `sessionStorage` della scheda, come nelle versioni precedenti. Non viene introdotta una sessione server applicativa né un cookie applicativo con token. Per token custoditi esclusivamente nel backend occorre integrare una sessione server nell’app ospitante.

Il rifiuto del refresh per sessione scaduta/revocata cancella lo stato locale. Gli errori temporanei di trasporto/servizio non cancellano i token e non vengono scambiati per una conferma di sessione valida. Logout o sostituzione della sessione invalidano le risposte di rinnovo pendenti. L’admin usa il controllo ogni 30 secondi; `watchAccess()` rinnova la sessione prima di controllare i permessi. Questi check periodici sono attività di rinnovo SSO: rimane applicabile la durata massima configurata nel provider.
