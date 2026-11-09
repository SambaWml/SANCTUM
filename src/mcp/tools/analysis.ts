import { UsAnalysisInput, saveUsAnalysis } from '../../analysis/us-analysis.ts';
import type { Db } from '../../state/db.ts';
import type { RegisterTool } from '../tooling.ts';

/** us_analysis_save: grava a análise da US (/analisar) e gera o relatório. Ver analysis/us-analysis.ts. */
export function registerAnalysisTools(
  tool: RegisterTool,
  deps: { db: Db; rootDir: string; cardOf: (issueKey: string) => { criteria: string[]; linkedBugs: string[] }; agent: () => string | null },
): void {
  tool(
    'us_analysis_save',
    'Grava a análise da US feita antes do teste (/analisar): resumo, lacunas por critério, perguntas ao PO, riscos/regressões, ' +
      'melhorias na funcionalidade (sugestão, nunca regra nem bug) e rascunho de cenários no padrão Sanctum. Gera relatório ' +
      'reports/<card>/analise-*.html e .md; o /qa parte dela pelo context_build. Exige o digest do card (digest_put). Nada vai ao Jira.',
    UsAnalysisInput.shape,
    (a) => {
      const res = saveUsAnalysis(deps.db, deps.rootDir, a, deps.cardOf(a.issueKey), deps.agent());
      return {
        id: res.id, report: res.report,
        coverage: res.coverage ? { uncovered: res.coverage.uncovered, withoutCode: res.coverage.withoutCode } : null,
        draftProblems: res.draftProblems,
        next: 'Mostre ao usuário o resumo, as perguntas ao PO e as melhorias, e abra o HTML. Não publique no Jira sem pedido.',
      };
    },
  );
}
