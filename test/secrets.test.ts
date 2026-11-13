import { describe, expect, it } from 'vitest';
import { SecretError, SecretStore } from '../src/security/secrets.ts';

const env = {
  APP_ADMIN_PASSWORD: 'p4ssw0rd!',
  APP_URL: 'https://dev.exemplo.com',
  JIRA_API_TOKEN: 'tok-abcdef',
  SHORT_TOKEN: 'abc',
  PATH: '/usr/bin',
};

describe('SecretStore', () => {
  const store = new SecretStore(['APP_ADMIN_PASSWORD', 'APP_URL'], env);

  it('resolve referência permitida', () => {
    expect(store.resolve('secret:APP_ADMIN_PASSWORD')).toBe('p4ssw0rd!');
  });

  it('não resolve segredo que a config não referencia (ex.: token pessoal no .env), mas ainda o redige', () => {
    expect(() => store.resolve('secret:JIRA_API_TOKEN')).toThrow(/não é referenciada pela config/);
    expect(store.valuesForRedaction().map((s) => s.name)).toContain('JIRA_API_TOKEN');
  });

  it('recusa variável que não é segredo nem referenciada', () => {
    expect(() => store.resolve('secret:PATH')).toThrow(SecretError);
  });

  it('recusa formato inválido', () => {
    expect(() => store.resolve('APP_ADMIN_PASSWORD')).toThrow(/referência inválida/);
  });

  it('erro de variável ausente cita o nome, não valor', () => {
    const s = new SecretStore(['MISSING_PASSWORD'], {});
    expect(() => s.resolve('secret:MISSING_PASSWORD')).toThrow('MISSING_PASSWORD não está definida no .env');
  });

  it('entrega para redação só segredos (não URL) com tamanho mínimo', () => {
    const names = store.valuesForRedaction().map((s) => s.name).sort();
    expect(names).toEqual(['APP_ADMIN_PASSWORD', 'JIRA_API_TOKEN']);
  });

  it('redige senha de papel com qualquer nome de variável e nomes em português (13/11)', () => {
    const s = new SecretStore(['LOJA_ADMIN_CHAVE', 'LOJA_USER'], { LOJA_ADMIN_CHAVE: 'k3y-secreta', LOJA_USER: 'maria', OUTRA_SENHA: 's3nha-x', APP_PWD: 'pwd-123' }, ['LOJA_ADMIN_CHAVE']);
    expect(s.valuesForRedaction().map((x) => x.name).sort()).toEqual(['APP_PWD', 'LOJA_ADMIN_CHAVE', 'OUTRA_SENHA']);
  });

  it('lista ausentes por nome', () => {
    expect(store.missing(['APP_URL', 'OTHER_PASSWORD'])).toEqual(['OTHER_PASSWORD']);
  });
});
