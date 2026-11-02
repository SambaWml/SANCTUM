const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function testChangeCard() {
  const regData = JSON.parse(readFileSync('runs/pending-registration.json', 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://portal-guruja-payment-dev.azurewebsites.net/entrar');
  await page.fill('input[name="nickName"]', regData.username);
  await page.fill('input[name="password"]', regData.password);
  await page.click('button:has-text("Entrar")');
  await page.waitForTimeout(4000);
  
  await page.click('button:has-text("Realizar o pagamento")');
  await page.waitForTimeout(4000);
  
  console.log('Clicando em "Usar outro cartão"...');
  await page.click('button:has-text("Usar outro cartão"), a:has-text("Usar outro cartão"), text=Usar outro cartão');
  await page.waitForTimeout(4000);
  
  const frames = page.frames().filter(f => f.url().includes('malga.io'));
  console.log('Frames Malga na fatura:', frames.length);
  
  if (frames.length > 0) {
    // Usar cartão com dígito final de aprovação no sandbox Malga: 5434 7396 7398 6384
    console.log('Preenchendo novo cartão aprovado (final 84)...');
    await frames[0].locator('input[name="card-number"]').pressSequentially('5434739673986384', { delay: 50 });
    await frames[1].locator('input[name="card-holder-name"]').pressSequentially('WESLEY LEOCADIO QA', { delay: 50 });
    await frames[2].locator('input[name="card-expiration-date"]').pressSequentially('0629', { delay: 50 });
    await frames[3].locator('input[name="card-cvv"]').pressSequentially('120', { delay: 50 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(2000);
  }
  
  const buttons = await page.$$eval('button', els => els.map(b => ({ text: b.textContent.trim(), disabled: b.disabled })));
  console.log('Botões disponíveis:', JSON.stringify(buttons, null, 2));

  await page.screenshot({ path: 'runs/change-card-screen.png', fullPage: true });

  await browser.close();
}

testChangeCard().catch(console.error);