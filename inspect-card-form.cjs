const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function testCardForm() {
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
  
  // 3. Pagamento - Selecionar Cartão de crédito e Continuar
  console.log('Selecionando Cartão de crédito...');
  await page.locator('label[for="payment-method-CreditCard"], text=Cartão de crédito').first().click();
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Continuar")');
  await page.waitForTimeout(3000);
  
  console.log('Inputs após selecionar cartão:');
  const cardInputs = await page.$$eval('input', inps => inps.map(i => ({ id: i.id, name: i.name, placeholder: i.placeholder, type: i.type })));
  console.log(JSON.stringify(cardInputs, null, 2));
  
  await browser.close();
}

testCardForm().catch(console.error);