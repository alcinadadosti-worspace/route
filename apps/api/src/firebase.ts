import { initializeApp, cert, applicationDefault, getApps, type App } from 'firebase-admin/app';

/**
 * App admin do Firebase, compartilhado por Firestore e Auth (uma única
 * inicialização — chamar initializeApp duas vezes sem nome lança erro).
 * Credenciais, em ordem: FIREBASE_SERVICE_ACCOUNT (JSON, env do Render) ou
 * GOOGLE_APPLICATION_CREDENTIALS (caminho, dev local). Sem nenhuma, retorna
 * null e a API cai em memória e SEM autenticação (dev/CI).
 */
let memo: App | null | undefined;

export function appFirebase(): App | null {
  if (memo !== undefined) return memo;
  const conteudo = process.env.FIREBASE_SERVICE_ACCOUNT;
  const caminho = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!conteudo && !caminho) {
    memo = null;
    return memo;
  }
  memo =
    getApps()[0] ??
    initializeApp({ credential: conteudo ? cert(JSON.parse(conteudo)) : applicationDefault() });
  return memo;
}
