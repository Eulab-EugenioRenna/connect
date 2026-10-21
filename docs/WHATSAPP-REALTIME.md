# WhatsApp realtime — SDK EULab 0.7.0

Connect espone un WebSocket nativo e autenticato per l’installazione. Non è il Socket.IO del gateway OpenWA separato: nell’app si usa l’SDK EULab, senza installare `socket.io-client` né esporre chiavi del provider.

## Uso nelle app

```ts
const wa = connect.whatsapp(installationId); // ConnectBrowser autenticato
const stream = wa.subscribe({
  onStatus(status) {
    // connecting, connected, reconnecting, closed, unauthorized, error
    mostraStatoConnessione(status);
  },
  onSnapshot({ sessions, outbox, bots }) {
    aggiornaConnessioni(sessions);
    // sessions[].qr: disponibile solo al gestore e durante il pairing.
    aggiornaInvii(outbox);
    aggiornaStatoBot(bots);
  },
  onEvent(event) {
    if (event.kind === 'bot.completed') {
      mostraRisultato(event.payload);
    }
    if (event.kind === 'message.received') {
      aggiornaConversazione(event.payload);
    }
  },
  onError(error) {
    mostraErroreConnessione(error.message);
  },
});

// Alla chiusura della pagina/componente:
stream.close();
```

La sottoscrizione restituisce subito `{close(), status}`. Nel browser il logout e la sostituzione della sessione chiudono le sottoscrizioni aperte. In caso di token scaduto, la riconnessione passa di nuovo dall’API, che usa il rinnovo SSO dell’SDK.

Sul backend serve Node.js 22 o successivo, con `WebSocket` globale:

```ts
// La callback deve restituire un access token valido dell’utente autorizzato.
const wa = connectServer.whatsapp(async () => ottieniTokenUtenteAggiornato());
const stream = wa.subscribe({ onEvent: gestisciEvento });
// Rimane compatibile anche connectServer.whatsapp(accessToken).
```

La callback del token è utile per rinnovare le credenziali nelle riconnessioni lunghe. Le sole credenziali server dell’installazione non autorizzano una sottoscrizione senza utente.

## Frame e autenticazione

1. L’SDK chiama `POST /v1/installations/:installationId/whatsapp/events/ticket` con l’autenticazione HTTP ordinaria e il permesso `whatsapp.read`.
2. L’API emette un ticket monouso valido 30 secondi; la credenziale utente è cifrata nel database e associata all’installazione. Il ticket è limitato a dieci emissioni pendenti per utente/installazione.
3. L’SDK apre `ws(s)://<api>/v1/whatsapp/events` e invia `{type:'authenticate',ticket}` nel primo frame. Nessun token, ticket o segreto compare nell’URL.
4. Il server consuma il ticket una sola volta, verifica l’origine quando associata dal browser e ricontrolla autenticazione e permessi.
5. Il server emette `ready`, poi `snapshot` e `event`. Non accetta comandi d’invio sul socket.

I ticket scaduti vengono rimossi periodicamente. Sono previsti timeout di autenticazione, heartbeat ping/pong, limiti di connessioni, frame in ingresso e buffer in uscita.

## Dati ricevuti

`snapshot` contiene:

- `sessions`: numero, stato, runner, avanzamento sincronizzazione e QR se autorizzato.
- `outbox`: ultimi 200 invii con esito e ID provider.
- `bots`: archivio, revisione e stato attivo/sospeso.

Gli eventi includono `id`, `session_id`, `kind`, `created_at` e `payload`. Tipi esposti: `message.received`, `message.sent`, `message.ack`, `connection.connected`, `connection.disconnected`, `connection.state`, `bot.step`, `bot.completed`.

Gli allegati non viaggiano nel flusso: si recuperano con l’API media esistente. Ogni sottoscrizione è limitata alla propria installazione; il QR richiede anche `whatsapp.manage`. L’accesso SSO, le autorizzazioni e lo stato dell’installazione vengono verificati prima di ogni batch. Una revoca del diritto di lettura chiude il socket; una revoca della gestione rimuove il QR dai successivi snapshot.

## Riconnessione e consistenza

Il server legge gli eventi persistiti e lo stato ogni secondo, quindi spinge solo gli snapshot cambiati e gli eventi non ancora trasmessi su quella connessione. La finestra di recupero degli eventi recenti è 60 secondi, con batch da 200 e massimo 5000 eventi nella finestra. L’SDK deduplica gli ID anche tra riconnessioni della stessa sottoscrizione.

La riconnessione automatica è abilitata per default, con otto tentativi consecutivi e attesa esponenziale da 1 a 15 secondi. `reconnect:false` la disabilita. Un rifiuto HTTP 401/403 o la revoca esplicita termina la sottoscrizione. La riconnessione non ripete mai gli invii WhatsApp.

Il WebSocket è per aggiornare l’interfaccia: per operazioni applicative durevoli restano i webhook firmati, con retry e deduplica dell’ID evento. Dopo una disconnessione superiore alla finestra, l’app rilegge conversazioni e storico tramite HTTP. L’admin conserva il controllo periodico di consistenza oltre alla sottoscrizione realtime.

## Distribuzione

Richiede la migrazione additiva `008-whatsapp-realtime.sql` dopo la 007. API, entrambi i runner e admin sono aggiornati nello stack Docker locale `eulab-connect`; i proxy Nginx locale e di produzione sono predisposti con `Upgrade`, `Connection` e HTTP/1.1. Anche Vite inoltra gli upgrade WebSocket.

Nel proxy pubblico a monte deve essere abilitato l’inoltro WebSocket verso `/v1/`. Il collaudo locale non certifica DNS, TLS o proxy pubblici di `auth.eulab.cloud`.

## Verifica eseguita

Suite completa in Docker: **64 test superati, nessuno saltato**. Chromium ha verificato il laboratorio IVR e i modelli del compositore su desktop e mobile. Sulla release avviata sono stati verificati login Keycloak reale, ticket, upgrade attraverso Nginx, frame `ready`/`snapshot` ricevuti dall’SDK e simulazione del bot con frase personalizzata. Evidenze: `docs/verification/whatsapp-realtime/live-result.json` e relative schermate. Nessun messaggio WhatsApp inviato, nessun bot installato o attivato; nel database di esercizio non erano presenti sessioni collegate.

Pacchetto pronto: `dist/sdk/eulab-connect-0.7.0.tgz`.
