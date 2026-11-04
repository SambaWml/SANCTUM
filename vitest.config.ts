import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nenhum teste fala com o Jira real pela twg (leitura automática de card e ferramentas jira_*).
    env: { NOVO_QA_TWG: 'off' },
  },
});
