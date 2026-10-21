# EULab Connect SDK

SDK ESM per SSO, permessi, utenti e WhatsApp tramite EULab Connect. Richiede un'installazione Connect configurata; il server SDK richiede Node.js 22 o successivo.

```sh
npm install @eulab/connect
```

```ts
import {ConnectBrowser} from '@eulab/connect/browser';

// Mantieni un'istanza condivisa nel service dell'applicazione.
const connect = new ConnectBrowser({
  apiUrl: 'https://auth.eulab.cloud',
  issuer: 'https://auth.eulab.cloud/sso/realms/eulab',
  clientId: 'client-id-della-tua-app',
  redirectUri: 'https://app.example/callback',
  installationId: 'id-installazione',
});
await connect.init({loginRequired: true});
```

L'entrypoint server espone `ConnectServer` e `verifyWebhook`:

```ts
import {ConnectServer, verifyWebhook} from '@eulab/connect/server';
```

Gli export browser e server includono le dichiarazioni TypeScript. Il pacchetto contiene solo JavaScript compilato, tipi e questo README; non contiene credenziali o profili WhatsApp. I segreti dell'installazione devono rimanere sul backend. Il backend deve verificare licenza e permessi per ogni operazione.
