import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const guiRoot = fileURLToPath(new URL('../', import.meta.url));

test('the packaging downloader still uses a proxy with the security override', async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'desk-download-proxy-'));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const payload = Buffer.from('local Electron download fixture');
  const requests = [];
  const proxy = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    proxy.closeAllConnections();
    proxy.close(resolve);
  }));

  // Use app-builder-lib's downloader, not Electron's separate newer copy.
  // Run in a child because global-agent patches the process's HTTP methods.
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { createRequire } = require('node:module');
    const fromBuilder = createRequire(require.resolve('app-builder-lib/package.json'));
    const { downloadArtifact } = fromBuilder('@electron/get');
    const { cacheRoot, checksum } = JSON.parse(process.argv[1]);
    downloadArtifact({
      version: '44.4.5', artifactName: 'electron', platform: 'linux', arch: 'x64',
      mirrorOptions: { mirror: 'http://artifact.invalid/' }, cacheRoot,
      checksums: { 'electron-v44.4.5-linux-x64.zip': checksum },
    }).then((file) => {
      assert.equal(fs.readFileSync(file, 'utf8'), 'local Electron download fixture');
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  await execFileAsync(process.execPath, ['-e', script, JSON.stringify({
    cacheRoot, checksum: createHash('sha256').update(payload).digest('hex'),
  })], {
    cwd: guiRoot,
    timeout: 15000,
    env: {
      ...process.env,
      ELECTRON_GET_USE_PROXY: '1',
      GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE: 'GLOBAL_AGENT_',
      GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      GLOBAL_AGENT_NO_PROXY: '',
    },
  });
  assert.deepEqual(requests, ['http://artifact.invalid/v44.4.5/electron-v44.4.5-linux-x64.zip']);
});
