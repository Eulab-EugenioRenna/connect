# EULab Connect

Connect governa l’accesso degli utenti alle funzioni esposte dalle applicazioni dei clienti.

## Linguaggio

**Applicazione**:
Un prodotto software con una propria identità e una lista comune di funzioni disponibili. Può avere più installazioni per lo stesso cliente o per clienti diversi.
_Evitare_: Dominio, sito, installazione come sinonimi di applicazione.

**Installazione**:
Una specifica copia di un’applicazione, appartenente a un cliente e individuata da dominio e percorso. Collegamenti degli utenti locali e connessioni WhatsApp appartengono all’installazione.
_Evitare_: App come sinonimo di singola installazione.

**WordPress**:
Un tipo di integrazione dell’installazione, realizzato tramite il plugin Connect. Un sito WordPress è un’installazione, non un’entità parallela all’applicazione.
_Evitare_: WordPress come terzo livello indipendente tra applicazione e installazione.

**Cliente**:
L’azienda o organizzazione a cui appartengono le installazioni e le licenze delle applicazioni. Una licenza del cliente per un’applicazione può servire più utenti collegati all’azienda, ciascuno con la propria identità e i propri ruoli.
_Evitare_: Utente, identità come sinonimi di cliente.

**Utente**:
La persona che accede con una propria identità centrale, collegabile a un’azienda tramite appartenenza e a un account locale di un’installazione. Non è il titolare aziendale della licenza.
_Evitare_: Cliente come sinonimo di utente.

**Funzione**:
Una capacità nominata che l’applicazione dichiara di esporre. La lista delle funzioni dell’applicazione costituisce la lista dei permessi assegnabili in Connect.
_Evitare_: Cataloghi separati e indipendenti di funzioni e permessi.

**Matrice delle funzioni**:
La dichiarazione dell’applicazione che elenca le sue funzioni disponibili. Definisce ciò che può essere assegnato, non ciò che è già consentito a un utente.
_Evitare_: Matrice dei ruoli, elenco utenti abilitati.

**Licenza**:
L’abilitazione commerciale di un cliente per un’applicazione, con stato, eventuale scadenza e funzioni acquistate e abilitate.
_Evitare_: Ruolo come sinonimo di licenza.

**Ruolo**:
Un insieme di funzioni assegnabili agli utenti di un cliente per un’applicazione. L’assegnazione non sostituisce la licenza né il collegamento all’installazione.
_Evitare_: Tipo di integrazione, licenza.
