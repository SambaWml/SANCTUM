const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function payWithMalgaFixed() {
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
  await page.waitForTimeout(5000);
  
  const frames = page.frames().filter(f => f.url().includes('malga.io'));
  console.log('Frames Malga:', frames.length);
  
  // Frame 0: número do cartão
  console.log('Preenchendo número do cartão no Frame 0...');
  await frames[0].locator('input:not([hidden])').fill('5434739673986368');
  await page.waitForTimeout(1000);
  
  // Frame 1: nome no cartão
  console.log('Preenchendo nome no Frame 1...');
  await frames[1].locator('input:not([hidden])').fill('WESLEY LEOCADIO QA');
  await page.waitForTimeout(1000);
  
  // Frame 2: validade
  console.log('Preenchendo validade no Frame 2...');
  await frames[2].locator('input:not([hidden])').fill('0629');
  await page.waitForTimeout(1000);
  
  // Frame 3: CVV
  console.log('Preenchendo CVV no Frame 3...');
  await frames[3].locator('input:not([hidden])').fill('120');
  await page.waitForTimeout(1500);
  
  // Aceitar termos
  console.log('Marcando checkbox de termos...');
  await page.locator('input#terms-checkbox').check({ force: true });
  await page.waitForTimeout(1000);
  
  const finishBtn = page.locator('button:has-text("Finalizar assinatura")');
  console.log('Botão Finalizar assinatura isDisabled?', await finishBtn.isDisabled());
  
  console.log('Clicando em Finalizar assinatura...');
  await finishBtn.click();
  
  await page.waitForTimeout(15000);
  
  console.log('URL após finalizar:', page.url());
  const bodyText = await page.innerText('body');
  console.log('Texto pós-pagamento:\n', bodyText.slice(0, 900));
  
  await browser.close();
}

payWithMalgaFixed().catch(console.error);