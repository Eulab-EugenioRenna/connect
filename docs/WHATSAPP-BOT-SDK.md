# Bot IVR EULab: configurazione dall’app cliente

Il bot è una funzione di Connect. L’SDK non contiene domande, risposte, livelli o modelli commerciali: l’app del cliente costruisce l’interfaccia di configurazione e invia la definizione tramite SDK. L’admin EULab contiene invece un laboratorio interno con un esempio di collaudo.

## Collegamento e attivazione

1. Il cliente autorizzato collega WhatsApp tramite `wa.connect()`, mostra `wa.qr(sessionId)` nella propria app e scansiona il QR.
2. L’app attende `state === 'connected'` e legge `archive_id` da `wa.sessions()`. L’archivio identifica l’installazione e il numero.
3. Il cliente configura la **frase di avvio**, le domande, i menu e le risposte nell’app. L’app salva con `wa.bot.configure()`.
4. Il cliente attiva esplicitamente il bot con `wa.bot.activate()`. Il salvataggio da solo non invia e non abilita risposte automatiche.
5. Un interlocutore scrive la frase di avvio in una chat privata: il bot comincia il percorso. Il confronto considera il messaggio intero, senza differenze tra maiuscole/minuscole e ignorando spazi iniziali/finali.

Fuori da un percorso attivo, gli altri messaggi non avviano il bot. Durante il percorso, `0` torna indietro, `menu` ricomincia; anche la frase di avvio ricomincia. Dopo la conclusione o la scadenza serve nuovamente la frase configurata. Un numero scollegato non può rispondere. Ricollegando lo stesso numero alla stessa installazione, la configurazione esplicitamente abilitata resta associata all’archivio.

## SDK browser e server

```ts
import type { WhatsAppBotDefinition } from '@eulab/connect/browser';

const wa = connect.whatsapp(installationId); // browser, con utente autenticato
// Sul backend: const wa = connectServer.whatsapp(userAccessToken);

// Valori prodotti dall’editor dell’app, non imposti dall’SDK.
const definition: WhatsAppBotDefinition = {
  name: 'Richieste clienti',
  trigger: 'PRENOTA',
  startNodeId: 'start',
  sessionTimeoutMinutes: 20,
  invalidReply: 'Scegli una delle opzioni elencate.',
  nodes: [
    { id: 'start', type: 'menu', text: 'Quale servizio ti interessa?', options: [
      { key: '1', label: 'Consulenza', next: 'name' },
      { key: '2', label: 'Informazioni', next: 'information' },
    ] },
    { id: 'name', type: 'question', text: 'Come ti chiami?', next: 'details' },
    { id: 'details', type: 'question', text: 'Quando preferisci essere ricontattato?', next: 'done' },
    { id: 'done', type: 'end', text: 'Richiesta raccolta. Ti ricontatteremo.', outcome: 'contact_requested' },
    { id: 'information', type: 'end', text: 'Scrivici la tua richiesta nell’app.', outcome: 'information' },
  ],
};

const current = await wa.bot.get(archiveId);
const saved = await wa.bot.configure(archiveId, definition, current.revision);
// Collegamento QR attivo e consenso del cliente all’automazione.
const active = await wa.bot.activate(archiveId, true, saved.revision);
// Sospensione:
await wa.bot.activate(archiveId, false, active.revision);
```

`get` restituisce `{archiveId, definition, revision, enabled, connected}`. Se il numero non ha un bot, `definition` è `null`, `revision` è `0`, `enabled` è `false`: nessun modello viene inserito automaticamente.

`configure` richiede la revisione letta e restituisce quella nuova. Una modifica concorrente dà HTTP 409: l’app rilegge e presenta il conflitto al cliente. Ogni salvataggio sospende il bot, cancella le conversazioni in corso e annulla le risposte ancora in coda. L’attivazione richiede la revisione corrente. Una risposta già presa in carico dal provider può essere in corso quando viene sospeso il bot.

## Contratto dei passaggi

- `menu`: testo e opzioni `{key,label,next}`; accetta sia la chiave (per esempio `1`) sia l’etichetta completa, senza distinzione di maiuscole.
- `question`: testo, raccolta della risposta libera e `next`.
- `end`: risposta finale e `outcome` facoltativo per l’app. Chiude la conversazione del bot.

L’app sceglie il numero di passaggi e i collegamenti. Sono validati ID univoci, destinazioni esistenti, raggiungibilità e scelte non ambigue. I comandi `0`, `menu` e la frase di avvio non possono coincidere con un’opzione. Limiti operativi: fino a 500 nodi, 30 opzioni per menu, testi dei nodi fino a 4000 caratteri, risposte libere fino a 2000 caratteri, timeout da 1 a 1440 minuti. Questi limiti non definiscono un numero fisso di livelli.

I menu vengono inviati come pulsanti nativi multipli tramite OpenWAUnlocked, senza chiave Insiders. Le domande aperte e i messaggi finali usano testo. Ogni scelta usa `ivr:v<revisione>:<nodo>:<chiave>`; i clic di un nodo precedente vengono rifiutati. Lo stesso motore espone prompt vocali, alias e input DTMF: [contratti SDK 0.8.0](OPENWAUNLOCKED-0.8.0.md).

## Simulazione dall’app e dall’admin

```ts
const first = await wa.bot.preview(definition, 'PRENOTA');
const second = await wa.bot.preview(definition, '1', first.state);
const third = await wa.bot.preview(definition, 'Mario', second.state);
// {reply, state, completed, answers, outcome?, sent:false}
```

La simulazione non richiede QR, non salva configurazioni, non modifica conversazioni reali e non crea invii. L’app conserva `state` tra i turni della sola prova. Ogni cambiamento della definizione deve azzerare quello stato. Il timeout è applicato dal runtime alle conversazioni reali.

Nell’admin: **WhatsApp → Test bot IVR**. Il modello EULab contiene menu, nome, servizio, giorno e risposta finale, con frase di avvio modificabile. La prova reale è separata: selezionare il numero, salvare il modello, quindi attivarlo esplicitamente. Queste azioni sostituiscono il bot di quel numero; nessun modello viene installato aprendo la pagina. Testo, sondaggio e allegati di collaudo sono precompilati anche nel compositore ordinario.

## Eventi per l’app

I webhook già configurati per l’installazione ricevono `bot.step` e `bot.completed`. Il payload contiene `archiveId`, `revision`, `chatId`, `messageId`, `outboxId`, `nodeId`, `answers` e `outcome`. Le risposte sono indicizzate dall’ID del nodo. I webhook hanno i consueti retry: l’app deduplica usando l’ID dell’evento.

`bot.completed` indica che il percorso è stato raccolto e la risposta finale accodata; non certifica consegna o una prenotazione esterna. L’app usa `outcome` per le proprie operazioni e gli eventi `message.sent`/ack per gli esiti WhatsApp.

## Esecuzione e autorizzazione

Configurazione e simulazione richiedono `whatsapp.manage`, lettura `whatsapp.read`, attivazione anche `whatsapp.send`. I permessi devono essere dichiarati dalla matrice dell’app, acquistati/abilitati e assegnati al cliente con collegamento locale. Le sole credenziali server senza utente non possono configurare il bot.

L’attivazione registra una delega persistente per l’automazione, così la scadenza della sessione UI non spegne il bot. Per le attivazioni cliente, il runtime ricontrolla permessi, identità, membership, licenza, collegamento e installazione prima della generazione e dell’invio. L’attivazione tecnica dell’admin è una delega operativa esplicita su quel numero, revocabile sospendendo il bot o l’installazione.

Stato, risposta in outbox ed evento vengono scritti nella stessa transazione. Gli ingressi duplicati non avanzano due volte il flusso. Le conversazioni sono separate per archivio e chat e sopravvivono al riavvio del runner. Gruppi, messaggi propri, importazioni storiche e messaggi precedenti alla disponibilità del client non avviano il bot; il runtime scarta inoltre ingressi più vecchi di due minuti. Un risultato provider incerto non causa un reinvio automatico.

## Installazione e verifica

Applicare tutte le migrazioni additive fino a `011-app-onboarding.sql` con `npm run db:migrate` **prima** di aggiornare API e runner. La 010 aggiunge solo la revoca dell’accesso a una singola applicazione; la 011 aggiunge il contratto di attivazione/migrazione e la copia cifrata del segreto delle installazioni. Nessuna delle due cancella archivi, messaggi o credenziali. Dopo l’aggiornamento distribuire anche l’admin e il pacchetto SDK generato localmente (0.9.0 per il contratto di onboarding).

Test locali: motore, API Nest con PostgreSQL WASM, SDK, autorizzazioni cliente, isolamento, rollback, persistenza, deduplica, scadenza, sospensione e webhook. Fixture PDF renderizzata e ispezionata; formati multimediali riconosciuti automaticamente.

Il limite del browser macOS è stato superato eseguendo Chromium in Docker. Il collaudo isolato desktop/mobile del compositore e del percorso IVR è riuscito, senza invii reali o configurazioni installate sui clienti. La migrazione 007 è applicata allo stack locale; API, admin e i due runner sono aggiornati. Il collaudo con WhatsApp reale resta da eseguire: al momento dell’aggiornamento non ci sono sessioni WhatsApp collegate.

L’SDK 0.7.0 aggiunge le sottoscrizioni [WebSocket EULab](WHATSAPP-REALTIME.md) per stato, QR, invii ed eventi bot.
