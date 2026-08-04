import { getAuth } from 'firebase-admin/auth';
import { appFirebase } from '../firebase.js';

/**
 * Autenticação da API (fecha a pendência "API aberta" da seção 13). Os apps
 * já logam com Firebase Auth; a API só precisa VERIFICAR o ID token que eles
 * mandam no header `Authorization: Bearer <token>`. É o único modelo seguro
 * para um cliente de navegador: um token estático no bundle do PWA seria
 * extraível por qualquer um. O papel vem do custom claim (mesma fonte das
 * security rules), então dá para exigir Admin Estoque onde faz sentido.
 */

export interface UsuarioAutenticado {
  uid: string;
  papel: string;
}

export interface Autenticador {
  verificar(token: string): Promise<UsuarioAutenticado | null>;
}

/** Verificador de ID token do Firebase; null sem credenciais (dev/CI → API aberta). */
export function criarAutenticador(): Autenticador | null {
  const app = appFirebase();
  if (!app) return null;
  const auth = getAuth(app);
  return {
    async verificar(token) {
      try {
        const decodificado = await auth.verifyIdToken(token);
        const papel = typeof decodificado.papel === 'string' ? decodificado.papel : '';
        return { uid: decodificado.uid, papel };
      } catch {
        return null;
      }
    },
  };
}
