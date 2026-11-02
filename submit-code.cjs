const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function enterCodeAndSubmit(code) {
  const regData = JSON.parse(readFileSync('runs/pending-registration.json', 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://portal-guruja-payment-dev.azurewebsites.net/criar-conta');
  await page.fill('input[name="fullName"]', regData.name);
  await page.fill('input[name="email"]', regData.email);
  await page.fill('input[name="cpf"]', regData.cpf);
  await page.click('button:has-text("Continuar")');
  await page.waitForTimeout(3000);
  
  await page.fill('input[name="nickName"]', regData.username);
  await page.fill('input[name="password"]', regData.password);
  await page.fill('input[name="confirmPassword"]', regData.password);
  await page.click('button:has-text("Continuar")');
  await page.waitForTimeout(4000);
  
  console.log('Tela atual:', await page.innerText('body').then(t => t.slice(0, 300)));
  
  const inputs = await page.$$('input');
  console.log(`Inputs de código na tela: ${inputs.length}`);
  
  const digits = code.replace(/\s+/g, '').split('');
  console.log('Preenchendo dígitos:', digits);
  
  if (inputs.length === digits.length) {
    for (let i = 0; i < digits.length; i++) {
      await inputs[i].fill(digits[i]);
    }
  } else if (inputs.length === 1) {
    await inputs[0].fill(digits.join(''));
  } else {
    // Tentar digitar nos inputs existentes
    for (let i = 0; i < Math.min(inputs.length, digits.length); i++) {
      await inputs[i].fill(digits[i]);
    }
  }
  
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Validar código")');
  await page.waitForTimeout(5000);
  
  console.log('URL após Validar código:', page.url());
  const postValidationText = await page.innerText('body');
  console.log('Texto pós-validação:\n', postValidationText.slice(0, 500));
  
  await browser.close();
}

enterCodeAndSubmit('27609').catch(console.error);