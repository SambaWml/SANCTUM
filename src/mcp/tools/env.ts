import { EnvRegisterInput, registerEnvironment } from '../../config/register.ts';
import type { RegisterTool } from '../tooling.ts';

/** env_register: cadastra ambiente/papel/projeto novo sem editar YAML (ver config/register.ts). */
export function registerEnvTools(tool: RegisterTool, deps: { rootDir: string }): void {
  tool(
    'env_register',
    'Cadastra ambiente novo (ou papel novo num ambiente existente, ou projeto novo) em config/ sem editar o YAML. ' +
      'Só acrescenta: não altera o que existe e deixa a criação de dados desligada (liberar é decisão do usuário). ' +
      'Senha só como nome de variável do .env (envVar); o usuário preenche o .env, nunca no chat. Depois: config_reload.',
    EnvRegisterInput.shape,
    (a) => registerEnvironment(deps.rootDir, a),
  );
}
