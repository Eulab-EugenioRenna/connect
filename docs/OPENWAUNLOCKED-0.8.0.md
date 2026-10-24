# Connect SDK 0.8.0 e OpenWAUnlocked

Il runner installa dal registry `@eulab/openwaunlocked-core`, `-client` e `-driver-puppeteer` 1.0.0 con lockfile. Non serve una chiave di licenza provider. I permessi e le licenze delle applicazioni gestiti da Connect continuano a essere verificati.

## Messaggi interattivi

```ts
const wa = connect.whatsapp(installationId);
const payload = {
  kind: 'interactive' as const,
  to: '+393331234567',
  content: {
    type: 'buttons' as const,
    body: 'Come possiamo aiutarti?',
    actions: [
      {type: 'reply' as const, id: 'info', label: 'Informazioni'},
      {type: 'reply' as const, id: 'appointment', label: 'Appuntamento'},
      {type: 'reply' as const, id: 'support', label: 'Assistenza'},
      {type: 'reply' as const, id: 'prices', label: 'Prezzi'},
    ],
  },
};
await wa.test(sessionId, payload); // validazione, nessun invio
await wa.send(sessionId, payload, crypto.randomUUID()); // invio esplicito
```

`content` può essere `buttons` o `list`. I pulsanti supportano azioni `reply`, `url` HTTPS, `call` con numero e `copy` con codice. Le risposte non possono essere mescolate con le altre azioni nello stesso documento; gli ID devono essere univoci. Per le liste usare `buttonLabel` e `sections: [{title, rows: [{id, title, description}]}]`. I documenti non consentono percorsi locali del server, URL di media o payload WAPI arbitrari. Le azioni `call` dei messaggi sono CTA sul telefono del destinatario, distinte dal futuro pannello chiamate.

L’accodamento non conferma la consegna. L’outbox registra l’ID restituito dal provider; un risultato ambiguo rimane `uncertain` senza reinvio automatico. Riutilizzare una chiave di idempotenza solo per la stessa richiesta.

## IVR condiviso con il futuro agente

Ogni nodo può specificare `speech`; ogni scelta può specificare `aliases`. I menu generano pulsanti con ID `ivr:v<revisione>:<nodo>:<chiave>` e comandi Indietro/Ricomincia. `prompt` espone `nodeId`, `text`, `speech`, `expects` e `choices` con `id`, `key`, `label`, `dtmf`. Una scelta appartenente a un altro passaggio non viene salvata come risposta libera; i clic appartenenti a una revisione precedente vengono ignorati. Gli ID logici di `prompt.choices` restano `ivr:<nodo>:<chiave>`, usati dalla simulazione e dalla sessione vocale con snapshot della definizione.

```ts
const preview = await wa.bot.preview(definition, {type: 'start'}, null, 'voice');
// Simulazione: niente chiamate, audio o messaggi.
console.log(preview.prompt?.speech);

const first = await wa.ivr.start(archiveId, externalCallId, startKey);
// Il futuro agente pronuncia first.result.prompt.speech con il proprio TTS.
const next = await wa.ivr.advance(
  archiveId, first.id, {type: 'dtmf', value: '2'}, first.turn, turnKey,
);
// Oppure input {type:'speech',value:trascrizione}, {type:'choice',value:id},
// {type:'back'}, {type:'restart'}.
const current = await wa.ivr.get(archiveId, first.id);
```

Le sessioni vocali sono separate dalle conversazioni WhatsApp. Salvano uno snapshot della definizione e della revisione, lo stato e gli esiti di ogni turno. Il proprietario autenticato e l’archivio devono corrispondere; `expectedTurn` impedisce avanzamenti concorrenti. Stessa chiave e stessi dati restituiscono lo stesso esito; dati diversi danno 409. Dopo completamento o scadenza occorre una nuova sessione con un altro `externalCallId`. I menu comprendono le etichette, le chiavi e gli alias configurati; non viene effettuata interpretazione semantica tramite un modello AI.

Queste API non sintetizzano audio, non eseguono ASR, non collegano un modello AI e non avviano chiamate. L’adapter del futuro agente utilizzerà il contratto sopra per tali funzioni.

## Operazioni provider e contatti

`wa.refreshContact(sessionId, chatId)` accoda il recupero del nome, nome pubblico, descrizione e immagine profilo. `wa.operations.get(id)` e `.list()` restituiscono stato e risultato. `wa.conversations(archiveId)` include `contact`; l’admin aggiorna il profilo selezionato quando manca. Foto o descrizioni non disponibili per privacy/limiti del provider rimangono assenti: la UI mostra iniziali e identificativo, senza inventare dati.

Le chiamate sono **Coming soon nell’admin**. L’SDK espone già `wa.calls.inspect`, `.start` e `.control`, attraverso la coda delle operazioni. Il risultato di `inspect` contiene capacità effettive e chiamata attiva; `start/control` riportano l’esito del provider, inclusa indisponibilità. Nessuna capacità audio o video viene promessa se il runtime non la dichiara. I comandi usano l’identità completa `{id,sessionId,generation}` e non ammettono descrittori di file/audio del server.

Le operazioni ricontrollano token, permessi, installazione, connessione e lease nel runner, vengono prese in carico una sola volta e restano `uncertain` se il processo termina durante l’esecuzione. Gli eventi `call.incoming`, `call.state` e `provider.operation.completed` vengono salvati e inoltrati tramite i webhook configurati e il flusso realtime.

## Installazione e verifiche

Applicare le migrazioni 001–010 prima di distribuire API/runner. La 009 aggiunge contatti, operazioni provider e sessioni IVR; la 010 aggiunge la revoca dell’accesso a una singola applicazione. Nessuna delle due modifica identità, archivi o messaggi esistenti. Conservare `DATA_ENCRYPTION_KEY` e volumi. Il nuovo checkpoint è separato dai profili 5.6.6 e richiede un nuovo pairing QR.

Verifiche automatiche: `npm test`, `npm run build`, `npm run infra:check`, `npm run env:check`. `npm run verify:whatsapp` usa API e database isolati: non invia su WhatsApp. Su host senza Chromium compatibile eseguirlo nell’immagine runner montando il sorgente e impostando `CHROMIUM_PATH=/usr/bin/chromium`.

L’SDK viene compilato in `packages/sdk/dist`; creare l’archivio con `cd packages/sdk && npm pack --pack-destination ../../dist/sdk`. La pubblicazione npm dell’SDK non è automatica.
