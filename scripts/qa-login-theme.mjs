import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import http from 'node:http';

process.loadEnvFile('.env');
const servers = [];
if (process.env.QA_DOCKER === 'true') {
  for (const [port, host, target] of [[8088, 'web', 80], [8080, 'keycloak', 8080]]) {
    const server = http.createServer((req, res) => {
      const upstream = http.request({hostname: host, port: target, path: req.url, method: req.method, headers: {...req.headers, host: `localhost:${port}`}}, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => {res.writeHead(502); res.end();});
      req.pipe(upstream);
    });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    servers.push(server);
  }
}
let browser;
let page;
const checks = [], errors = [];
const output = 'docs/verification';
await mkdir(output, {recursive: true});
try {
  browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
  page = await browser.newPage({viewport: {width: 1440, height: 1000}, locale: 'it-IT'});
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().includes('/resources/') && response.status() >= 400) errors.push(`Risorsa tema: ${response.status()}`);
  });
  async function openLogin() {
    await page.goto('http://localhost:8088/');
    await page.getByRole('button', {name: 'Accedi con EULab SSO'}).click();
    await page.locator('#kc-login').waitFor();
    assert.equal(new URL(page.url()).pathname, '/realms/eulab/protocol/openid-connect/auth');
  }
  async function capture(name, width, height) {
    await page.setViewportSize({width, height});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Overflow orizzontale');
    await page.screenshot({path: `${output}/${name}.png`, fullPage: true});
  }
  await openLogin();
  await page.getByRole('heading', {name: 'Bentornato.'}).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'it');
  assert.equal(await page.locator('.eulab-wordmark').innerText(), 'EULAB\nCONNECT');
  assert.equal(await page.locator('.card-pf').evaluate(el => getComputedStyle(el).borderRadius), '24px');
  await capture('keycloak-login-desktop', 1440, 1000);
  await capture('keycloak-login-mobile', 390, 844);
  await capture('keycloak-login-small', 320, 640);
  checks.push('Tema EULab e lingua italiana serviti dal Keycloak reale; desktop 1440 e mobile 390/320 senza overflow');

  await page.locator('#password').fill('Verifica-visibilita');
  await page.locator('[data-password-toggle]').click();
  assert.equal(await page.locator('#password').getAttribute('type'), 'text');
  await page.locator('[data-password-toggle]').click();
  assert.equal(await page.locator('#password').getAttribute('type'), 'password');
  await page.locator('#password').fill('');
  checks.push('Mostra/nascondi password nativo funzionante');

  await page.setViewportSize({width: 1440, height: 1000});
  await page.getByRole('link', {name: 'Password dimenticata?'}).click();
  await page.getByRole('heading', {name: 'Recupera la password.'}).waitFor();
  await page.locator('#username').waitFor();
  await capture('keycloak-reset-desktop', 1440, 1000);
  await capture('keycloak-reset-mobile', 390, 844);
  checks.push('Recupero password con lo stesso tema; nessuna email inviata');
  await page.getByRole('link', {name: /Torna all’accesso/}).click();
  await page.locator('#username').fill('eulab-theme-check-nonexistent');
  await page.locator('#password').fill('invalid-theme-check');
  await page.locator('#kc-login').click();
  await page.locator('#input-error').waitFor();
  assert.equal(await page.locator('#username').getAttribute('aria-invalid'), 'true');
  await page.locator('#username').fill('');
  await capture('keycloak-login-error-mobile', 390, 844);
  checks.push('Errore credenziali nativo visibile e accessibile');

  await openLogin();
  await page.locator('#kc-current-locale-link').click();
  const english = page.locator('#language-switch1 a').filter({hasText: /English/});
  await english.click();
  await page.getByRole('heading', {name: 'Welcome back.'}).waitFor();
  checks.push('Selettore lingua inglese funzionante');

  await page.locator('#username').fill(process.env.EULAB_ADMIN_USERNAME);
  await page.locator('#password').fill(process.env.EULAB_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await page.waitForURL('http://localhost:8088/**');
  await page.getByRole('heading', {name: 'Panoramica', exact: true}).waitFor();
  checks.push('Login con amministratore esistente e ritorno alla dashboard tramite PKCE');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/keycloak-theme-result.json`, JSON.stringify({status: 'passed', at: new Date().toISOString(), realKeycloak: true, checks}, null, 2) + '\n');
  console.log(JSON.stringify({status: 'passed', checks}, null, 2));
} catch (error) {
  if (page) await page.screenshot({path: `${output}/keycloak-theme-failure.png`, fullPage: true}).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
}
