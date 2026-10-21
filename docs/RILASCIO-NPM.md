# Bundle npm

Dalla root Connect, con le dipendenze di entrambi i progetti già installate:

```sh
npm run package:npm
npm run verify:npm
```

La preparazione compila OpenWAUnlocked e Connect SDK, verifica i pacchetti e genera:

- `dist/releases/npm/`: 33 tarball OpenWAUnlocked `1.0.0` e `@eulab/connect@0.8.0`, con `manifest.json` e `SHA256SUMS`.
- `dist/releases/eulab-npm-bundle.tar.gz`: archivio trasportabile con gli stessi tarball e manifest.

La verifica installa tutti i tarball in un progetto temporaneo, controlla export ESM/CJS, asset e patch OpenWAUnlocked, API audio e aiuto CLI. Verifica separatamente gli import browser/server e i tipi TypeScript del Connect SDK. Non associa WhatsApp e non invia messaggi. Se le dipendenze sono già nella cache npm, si può verificare senza rete con `npm_config_offline=true npm run verify:npm`.

Il SDK contiene solo `dist` (JavaScript e dichiarazioni TypeScript), README e manifest, senza sorgenti o source map. Gli altri pacchetti mantengono i propri asset e le licenze necessari. API Connect, frontend, runner e provider Keycloak sono componenti dello stack Docker; il plugin WordPress viene distribuito tramite il proprio installer, non su npm.

## Pubblicazione

Accedere con `npm login --auth-type=web --registry=https://registry.npmjs.org/` e verificare l'account con `npm whoami`. Prima di inviare un tarball, controllare la versione esatta nel registry. Una risposta 404 con rete funzionante è diversa da un errore DNS o di autenticazione.

Per OpenWAUnlocked usare il flusso esistente dalla cartella `openwaunlocked`: `npm run release:npm:check -- --auth=login`, poi `npm run release:npm:publish -- --auth=login` da terminale interattivo. Richiede una working tree pulita e salta le versioni già pubblicate. Non incrementare le versioni soltanto per superare un errore di rete o staging. Su E429 interrompere; su E409 verificare prima `npm stage list` e lo stato del pacchetto, senza ripetere l'upload.

Per il Connect SDK, dalla root, dopo aver controllato che la versione non sia già pubblicata:

```sh
npm view @eulab/connect@0.8.0 version --registry=https://registry.npmjs.org/
npm publish dist/releases/npm/eulab-connect-0.8.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

La pubblicazione può richiedere login e 2FA. Confermare manifest pubblico, tag `latest` e disponibilità del tarball prima di dichiarare concluso il rilascio. `package:npm` e `verify:npm` non eseguono pubblicazioni.
