const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function payWithMalga() {
  const regData = JSON.parse(readFileSync('runs/pending-registration.json', 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://portal-guruja-payment-dev.azurewebsites.net/entrar');
  await page.fill('input[name="nickName"]', regData.username);
  await page.fill('input[name="password"]', regData.password);
  await page.click('button:has-text("Entrar")');
  await page.waitForTimeout(5000);
  
  // 1. Identificação
  await page.fill('input#personal-phone', '11988887777');
  await page.fill('input#personal-birthDate', '15051995');
  await page.fill('input#personal-cep', '01310100');
  await page.waitForTimeout(2000);
  await page.fill('input#personal-street', 'Avenida Paulista');
  await page.fill('input#personal-neighborhood', 'Bela Vista');
  await page.fill('input#personal-city', 'São Paulo');
  await page.fill('input#personal-state', 'SP');
  await page.fill('input#personal-number', '1000');
  await page.click('button:has-text("Confirmar informações")');
  await page.waitForTimeout(3000);
  
  // 2. Plano
  await page.locator('text=Mensal').first().click();
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Continuar")');
  await page.waitForTimeout(3000);
  
  // 3. Pagamento
  await page.locator('label[for="payment-method-CreditCard"]').click();
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Continuar")');
  await page.waitForTimeout(4000);
  
  console.log('Preenchendo frames do Malga...');
  // Frame 1: Número do cartão (placeholder 0000 0000 0000 0000)
  // Frame 2: Nome no cartão (placeholder Nome como no cartão)
  // Frame 3: Validade (placeholder 00/00)
  // Frame 4: CVV (placeholder 000)
  
  const frames = page.frames().filter(f => f.url().includes('malga.io'));
  console.log(`Malga frames encontrados: ${frames.length}`);
  
  for (const f of frames) {
    const input = f.locator('input').first();
    if (await input.count()) {
      const placeholder = await input.getAttribute('placeholder');
      if (placeholder && placeholder.includes('0000')) {
        console.log('Preenchendo número do cartão...');
        await input.fill('5434739673986368');
      } else if (placeholder && placeholder.includes('Nome')) {
        console.log('Preenchendo nome do cartão...');
        await input.fill('WESLEY LEOCADIO QA');
      } else if (placeholder && placeholder.includes('00/00')) {
        console.log('Preenchendo validade...');
        await input.fill('06/29');
      } else if (placeholder && (placeholder === '000' || placeholder.includes('000'))) {
        console.log('Preenchendo CVV...');
        await input.fill('120');
      }
    }
  }
  
  await page.waitForTimeout(2000);
  
  // Aceitar termos
  console.log('Aceitando termos...');
  await page.click('label[for="terms-checkbox"]');
  await page.waitForTimeout(1000);
  
  const finishBtn = page.locator('button:has-text("Finalizar assinatura")');
  console.log('Botão Finalizar assinatura está habilitado?', !(await finishBtn.isDisabled()));
  
  await finishBtn.click();
  console.log('Aguardando processamento do pagamento...');
  await page.waitForTimeout(10000);
  
  console.log('URL após pagamento:', page.url());
  const bodyText = await page.innerText('body');
  console.log('Texto pós-pagamento:\n', bodyText.slice(0, 800));
  
  await browser.close();
}

payWithMalga().catch(console.error);