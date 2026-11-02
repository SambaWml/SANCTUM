const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function testCardEntryAndPay() {
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
  
  // Inspecionar inputs de cartão
  const iframes = page.frames();
  console.log(`Frames na página: ${iframes.length}`);
  
  const cardInputs = await page.$$eval('input', inps => inps.map(i => ({ id: i.id, name: i.name, placeholder: i.placeholder })));
  console.log('Inputs encontrados:\n', JSON.stringify(cardInputs, null, 2));
  
  // Preencher cartão de teste: 5434 7396 7398 6368 | 06/2029 | 120
  const numInput = page.locator('input[placeholder*="Número"], input#card-number, input[name*="number"]').first();
  if (await numInput.count()) await numInput.fill('5434739673986368');
  
  const holderInput = page.locator('input[placeholder*="Nome"], input#card-holder, input[name*="holder"]').first();
  if (await holderInput.count()) await holderInput.fill('WESLEY LEOCADIO QA');
  
  const expInput = page.locator('input[placeholder*="Validade"], input#card-expiration, input[placeholder*="MM"]').first();
  if (await expInput.count()) await expInput.fill('0629');
  
  const cvvInput = page.locator('input[placeholder*="CVV"], input#card-cvv, input[name*="cvv"]').first();
  if (await cvvInput.count()) await cvvInput.fill('120');
  
  // Marcar termos de uso
  await page.locator('label[for="terms-checkbox"]').click();
  await page.waitForTimeout(1000);
  
  console.log('Clicando em Finalizar assinatura...');
  await page.click('button:has-text("Finalizar assinatura")');
  await page.waitForTimeout(8000);
  
  console.log('URL após finalizar assinatura:', page.url());
  const postPayText = await page.innerText('body');
  console.log('Texto pós-finalizar:\n', postPayText.slice(0, 800));
  
  await browser.close();
}

testCardEntryAndPay().catch(console.error);