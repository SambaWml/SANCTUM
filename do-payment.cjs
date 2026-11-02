const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

async function fillCheckoutAndPay() {
  const regData = JSON.parse(readFileSync('runs/pending-registration.json', 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 1. Login no payment
  await page.goto('https://portal-guruja-payment-dev.azurewebsites.net/entrar');
  await page.fill('input[name="nickName"]', regData.username);
  await page.fill('input[name="password"]', regData.password);
  await page.click('button:has-text("Entrar")');
  await page.waitForTimeout(5000);
  
  console.log('1. Preenchendo dados de identificação...');
  // Campos: telefone, data de nascimento, CEP, etc.
  const phoneInput = page.locator('input[placeholder*="Telefone"], input[name*="phone"]').first();
  if (await phoneInput.count()) await phoneInput.fill('11999998888');
  
  const birthInput = page.locator('input[placeholder*="Data"], input[name*="birth"], input[placeholder*="dd/mm"]').first();
  if (await birthInput.count()) await birthInput.fill('15/05/1995');
  
  const cepInput = page.locator('input[placeholder*="CEP"], input[name*="cep"]').first();
  if (await cepInput.count()) {
    await cepInput.fill('01310-100');
    await page.waitForTimeout(2000);
  }
  
  const numInput = page.locator('input[placeholder*="Número"], input[name*="number"]').first();
  if (await numInput.count()) await numInput.fill('1000');
  
  console.log('Clicando em Confirmar informações / Continuar...');
  const nextBtn = page.locator('button:has-text("Confirmar"), button:has-text("Continuar")').first();
  await nextBtn.click();
  await page.waitForTimeout(4000);
  
  console.log('Etapa 2 (Plano) - Texto:\n', await page.innerText('body').then(t => t.slice(0, 500)));
  
  // Selecionar o primeiro plano disponível
  const selectPlanBtn = page.locator('button:has-text("Selecionar"), button:has-text("Escolher"), button:has-text("Assinar")').first();
  if (await selectPlanBtn.count()) {
    console.log('Selecionando plano...');
    await selectPlanBtn.click();
    await page.waitForTimeout(4000);
  } else {
    // Tentar clicar em algum card de plano
    const planCard = page.locator('text=Mensal, text=Anual').first();
    if (await planCard.count()) await planCard.click();
    await page.waitForTimeout(2000);
    const contBtn = page.locator('button:has-text("Continuar")').first();
    if (await contBtn.count()) await contBtn.click();
    await page.waitForTimeout(4000);
  }
  
  console.log('Etapa 3 (Pagamento) - Texto:\n', await page.innerText('body').then(t => t.slice(0, 500)));
  
  // Preencher cartão de teste: 5434 7396 7398 6368 | 06/2029 | 120
  const cardNum = page.locator('input[placeholder*="Número"], input[name*="card"]').first();
  if (await cardNum.count()) await cardNum.fill('5434739673986368');
  
  const cardHolder = page.locator('input[placeholder*="Nome"], input[name*="holder"]').first();
  if (await cardHolder.count()) await cardHolder.fill('WESLEY LEOCADIO QA');
  
  const cardExp = page.locator('input[placeholder*="MM"], input[placeholder*="Validade"]').first();
  if (await cardExp.count()) await cardExp.fill('06/29');
  
  const cardCvv = page.locator('input[placeholder*="CVV"], input[placeholder*="CVC"]').first();
  if (await cardCvv.count()) await cardCvv.fill('120');
  
  console.log('Finalizando assinatura...');
  const payBtn = page.locator('button:has-text("Finalizar"), button:has-text("Pagar")').first();
  if (await payBtn.count()) {
    await payBtn.click();
    await page.waitForTimeout(8000);
  }
  
  console.log('Resultado pós-pagamento URL:', page.url());
  const finalResultText = await page.innerText('body');
  console.log('Texto pós-pagamento:\n', finalResultText.slice(0, 500));
  
  await browser.close();
}

fillCheckoutAndPay().catch(console.error);