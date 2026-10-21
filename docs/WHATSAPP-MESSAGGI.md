# Messaggi WhatsApp: admin e SDK

Il compositore nell’admin espone testo, immagine PNG/JPEG/WebP, PDF, audio MPEG/OGG/MP4, video MP4 e sondaggi (2–12 opzioni). Il file viene letto localmente e inviato come data URL, massimo 10 MB nel compositore. Il backend verifica anche la corrispondenza tra MIME e tipo di messaggio.

**Verifica senza inviare** chiama `POST /v1/installations/:installationId/whatsapp/sessions/:id/messages/test`: applica autorizzazioni e schema dell’invio, normalizza il destinatario e restituisce `{valid,kind,to,connected,sent:false}`. Non crea record nell’outbox e non contatta WhatsApp; non dimostra che il provider consegnerà il messaggio.

L’invio effettivo passa dalla coda esistente, con chiave di idempotenza e ricontrollo delle autorizzazioni. Un esito `uncertain` non viene reinviato automaticamente.

```ts
const wa = connect.whatsapp(userAccessToken); // SDK server
const payload = {
  kind: 'poll' as const,
  to: '+39 333 1234567',
  question: 'Quale giorno preferisci?',
  options: ['Lunedì', 'Martedì'],
};
await wa.test(sessionId, payload); // nessun invio
const result = await wa.send(sessionId, payload, stableIdempotencyKey);
const outbox = await wa.outbox();
```

Nell’SDK browser, il client si ottiene con `connect.whatsapp(installationId)`.

## Allegati mancanti

`wa.media(archiveId,messageId)` restituisce `{data,state:'available'}` se il file è archiviato. Se manca, accoda un recupero e restituisce `{data:null,state:'queued'}`. È necessaria una connessione attiva dello stesso archivio e un runner online. Richieste concorrenti per lo stesso messaggio condividono il job.

Il runner cerca il messaggio originale nella chat disponibile, decifra l’allegato e lo salva nello stesso archivio. Il recupero non invia messaggi. Dopo il recupero si può richiamare `media` per ottenere i dati. Se WhatsApp non conserva più messaggio/file, il job fallisce e l’allegato resta indisponibile. Non viene promesso il recupero di media scaduti.

La risincronizzazione può inoltre completare un allegato mancante senza duplicare il messaggio o emettere nuovamente il webhook di ricezione.

## Bot EULab

Il bot IVR EULab è implementato direttamente in Connect: [configurazione dall’app tramite SDK, frase di avvio e laboratorio admin](WHATSAPP-BOT-SDK.md). I modelli del compositore e del laboratorio sono esclusivamente fixture di collaudo admin.

## Plugin community: compatibilità

Il catalogo indicato dall’utente (`after-hours`, `chat-flow`, `faq-bot`, `typebot-connector`, ecc.) appartiene al progetto [rmyndharis/OpenWA-plugins](https://github.com/rmyndharis/OpenWA-plugins), destinato al gateway [rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA). Non è il contratto plugin dei pacchetti `@eulab/openwaunlocked-*` 1.0.0 usati dal runner Connect.

`chat-flow` propone menu testuali numerati con stato per chat; non equivale ai pulsanti nativi WhatsApp di `sendInteractive`. Il collegamento al gateway separato e la gestione dei suoi plugin non sono implementati in questa modifica. Il gateway indicato è `https://openwa.eulab.cloud`. Occorre verificarne API e sessioni senza sostituire gli archivi Connect.

## Verifiche locali

`npm test`: 48 test superati, 1 saltato (socket locale non consentito nel sandbox). `npm run build`: riuscito.

`scripts/verify-whatsapp-ui.mjs` prepara una prova del compositore con API Nest e database di test; il lancio Chromium è stato bloccato dal sandbox (EPERM/SIGTRAP), quindi nessuna accettazione visiva dichiarata. Docker e WhatsApp reali non verificati in questa sessione. Nessun messaggio reale inviato.
