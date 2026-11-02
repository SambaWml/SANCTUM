const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function verifyStudentAfterPayment() {
  const regData = JSON.parse(readFileSync('runs/pending-registration.json', 'utf8'));
  const envContent = readFileSync('.env', 'utf8');
  let adminPass = 'Guruja#Dev2024!';
  const m = envContent.match(/GURUJA_DEV_ADMIN_PASSWORD="?([^"\r\n]+)"?/);
  if (m) adminPass = m[1];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 1. Verificar tela de status de pagamento
  console.log('--- 1. Verificando status do pagamento ---');
  await page.goto('https://portal-guruja-payment-dev.azurewebsites.net/pagamento-status/14IBTFYA12OE8');
  await page.waitForTimeout(5000);
  const statusText = await page.innerText('body');
  console.log('Status do Pagamento body text:\n', statusText);
  await page.screenshot({ path: 'runs/payment-status.png', fullPage: true });

  // 2. Logar como admin no portal
  console.log('\n--- 2. Logando como admin no portal Guruja Dev ---');
  await page.goto('https://portal-guruja-dev.azurewebsites.net/entrar');
  await page.fill('input[name="nickName"]', 'frambachadmin');
  await page.fill('input[name="password"]', adminPass);
  await page.click('button:has-text("Entrar")');
  await page.waitForTimeout(6000);

  // 3. Consultar /guruja/alunos
  console.log('\n--- 3. Navegando para /guruja/alunos ---');
  await page.goto('https://portal-guruja-dev.azurewebsites.net/guruja/alunos');
  await page.waitForTimeout(6000);

  // Buscar pelo nome no input de busca
  const searchInput = page.locator('input[placeholder*="Buscar"], input[placeholder*="Pesquisar"], input[type="search"], input[type="text"]').first();
  if (await searchInput.count() > 0) {
    console.log('Digitando nome na busca de alunos...');
    await searchInput.fill('Wesley Leocadio');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
  }

  const tableText = await page.innerText('body');
  const foundInTable = tableText.includes('Wesley Leocadio') || tableText.includes('482.155.267-13') || tableText.includes('wesleocadio905');
  console.log('Aluno Wesley Leocadio encontrado na tela /guruja/alunos?', foundInTable);

  await page.screenshot({ path: 'runs/guruja-alunos-after-payment.png', fullPage: true });

  // 4. Consultar API /v2/Students diretamente com token de admin
  console.log('\n--- 4. Consultando API /v2/Students com filtro ---');
  const apiResp = await page.evaluate(async () => {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    const res = await fetch('https://api-dev.guruja.com.br/v2/Students?page=1&limit=50&search=Wesley', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (!res.ok) {
      // Tentar sem search
      const res2 = await fetch('https://api-dev.guruja.com.br/v2/Students?page=1&limit=50', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      return { status: res2.status, data: await res2.json() };
    }
    return { status: res.status, data: await res.json() };
  });

  console.log('API /v2/Students resultado:');
  console.log(JSON.stringify(apiResp, null, 2));

  // 5. Verificar também /admin/usuarios
  console.log('\n--- 5. Verificando em /admin/usuarios ---');
  await page.goto('https://portal-guruja-dev.azurewebsites.net/admin/usuarios');
  await page.waitForTimeout(4000);
  const adminUsersInput = page.locator('input[type="text"], input[type="search"]').first();
  if (await adminUsersInput.count() > 0) {
    await adminUsersInput.fill('Wesley Leocadio');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
  }
  const adminUsersText = await page.innerText('body');
  console.log('Presente em /admin/usuarios?', adminUsersText.includes('Wesley Leocadio') || adminUsersText.includes('482.155.267-13'));

  await page.screenshot({ path: 'runs/admin-usuarios-after-payment.png', fullPage: true });

  await browser.close();
}

verifyStudentAfterPayment().catch(console.error);