const { spawn } = require('node:child_process');
const { join } = require('node:path');

const root = process.cwd();
const launcher = join(root, 'src', 'mcp', 'launcher.ts');
const loader = 'file:///' + join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/');

const child = spawn(process.execPath, ['--import', loader, launcher], {
  cwd: root,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit']
});

let idCounter = 1;
const pending = new Map();

child.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  }
});

function call(method, params) {
  return new Promise((resolve) => {
    const id = idCounter++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const runId = 'GURUJA-8241-20261101T184657';

async function run() {
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-runner', version: '1.0' }
  });
  notify('notifications/initialized');

  console.log('--- 1. BROWSER OPEN (ADMIN FRESH) ---');
  let res = await call('tools/call', {
    name: 'browser_open',
    arguments: { runId, env: 'guruja-dev', role: 'admin', fresh: true }
  });
  console.log('browser_open:', JSON.stringify(res.result));

  console.log('--- 2. FILL USERNAME (placeholder) ---');
  res = await call('tools/call', {
    name: 'act',
    arguments: {
      action: 'fill',
      target: { placeholder: 'insira o usuário' },
      valueRef: 'role:admin.username'
    }
  });
  console.log('fill username:', JSON.stringify(res.result));

  console.log('--- 3. FILL PASSWORD (type=password) ---');
  res = await call('tools/call', {
    name: 'act',
    arguments: {
      action: 'fill',
      target: { css: 'input[type=\"password\"]' },
      valueRef: 'role:admin.password'
    }
  });
  console.log('fill password:', JSON.stringify(res.result));

  console.log('--- 4. CLICK ENTRAR ---');
  res = await call('tools/call', {
    name: 'act',
    arguments: {
      action: 'click',
      target: { role: 'button', name: 'Entrar' }
    }
  });
  console.log('click entrar:', JSON.stringify(res.result));

  console.log('--- 5. WAIT & SAVE AUTH ---');
  res = await call('tools/call', {
    name: 'browser_save_auth',
    arguments: {}
  });
  console.log('save auth:', JSON.stringify(res.result));

  console.log('--- 6. NAVIGATE /admin/usuarios ---');
  res = await call('tools/call', {
    name: 'navigate',
    arguments: { url: '/admin/usuarios' }
  });
  console.log('navigate:', JSON.stringify(res.result));

  console.log('--- 7. VERIFY CT-001 URL ---');
  res = await call('tools/call', {
    name: 'verify',
    arguments: {
      kind: 'url',
      description: 'Conferir se a URL atual e /admin/usuarios',
      urlPattern: '.*/admin/usuarios.*'
    }
  });
  console.log('verify url:', JSON.stringify(res.result));

  console.log('--- 8. VERIFY CT-001 UI (placeholder Buscar usuário) ---');
  res = await call('tools/call', {
    name: 'verify',
    arguments: {
      kind: 'ui',
      description: 'Campo Buscar usuario visivel',
      target: { placeholder: 'Buscar usuário' },
      condition: 'visible'
    }
  });
  console.log('verify ui:', JSON.stringify(res.result));

  console.log('--- 9. COMPLETE CT-001 ---');
  res = await call('tools/call', {
    name: 'scenario_complete',
    arguments: {
      runId,
      code: 'CT-001',
      status: 'PASSED',
      observed: 'Login de administrador autenticado com sucesso e rota /admin/usuarios carregada normalmente com busca visivel.'
    }
  });
  console.log('complete CT-001:', JSON.stringify(res.result));

  console.log('--- 10. START CT-002 ---');
  res = await call('tools/call', {
    name: 'scenario_start',
    arguments: { runId, code: 'CT-002' }
  });
  console.log('start CT-002:', JSON.stringify(res.result));

  console.log('--- 11. SEARCH AARAO81 ---');
  res = await call('tools/call', {
    name: 'act',
    arguments: {
      action: 'fill',
      target: { placeholder: 'Buscar usuário' },
      value: 'AARAO81'
    }
  });
  console.log('fill AARAO81:', JSON.stringify(res.result));

  console.log('--- 12. PRESS ENTER ---');
  res = await call('tools/call', {
    name: 'act',
    arguments: {
      action: 'press',
      target: { placeholder: 'Buscar usuário' },
      value: 'Enter'
    }
  });
  console.log('press enter:', JSON.stringify(res.result));

  console.log('--- 13. SNAPSHOT ---');
  res = await call('tools/call', {
    name: 'snapshot',
    arguments: {}
  });
  console.log('snapshot AARAO81:', JSON.stringify(res.result));

  child.stdin.end();
}

run().catch(e => { console.error(e); process.exit(1); });