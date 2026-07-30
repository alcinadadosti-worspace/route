import { useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from './firebase';

/** Papéis que a API aceita nas rotas do painel (ESCRITORIO, em app.ts). */
const ESCRITORIO = ['admin', 'operador'];

/** Sessão do usuário — login por e-mail/senha, contas criadas pelo admin (seção 2). */
export function useAutenticacao() {
  const [usuario, setUsuario] = useState<User | null>(null);
  const [carregando, setCarregando] = useState(true);
  /**
   * O papel vem do custom claim — a MESMA fonte que a API consulta. O painel
   * aceitava qualquer conta logada e só quebrava depois, uma requisição por vez:
   * uma conta de motorista entrava, via todas as abas e tomava 403 em tudo, com
   * mensagem que não dizia que o problema era a conta. Saber o papel aqui
   * permite dizer isso de uma vez, na cara.
   */
  const [papel, setPapel] = useState<string | null>(null);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUsuario(u);
        if (!u) {
          setPapel(null);
          setCarregando(false);
          return;
        }
        u.getIdTokenResult()
          .then((r) => setPapel(typeof r.claims.papel === 'string' ? r.claims.papel : ''))
          // Sem conseguir ler o claim, não trava o painel: a API continua sendo
          // a autoridade — isto aqui é só para explicar melhor.
          .catch(() => setPapel(null))
          .finally(() => setCarregando(false));
      }),
    [],
  );

  return {
    usuario,
    papel,
    /** null = não deu para saber; aí não bloqueia, quem decide é a API. */
    ehEscritorio: papel == null ? null : ESCRITORIO.includes(papel),
    carregando,
    entrar: (email: string, senha: string) => signInWithEmailAndPassword(auth, email, senha),
    sair: () => signOut(auth),
  };
}

export function mensagemDeErroAuth(codigo: string): string {
  switch (codigo) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-mail ou senha incorretos.';
    case 'auth/invalid-email':
      return 'E-mail inválido.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas — aguarde alguns minutos.';
    case 'auth/network-request-failed':
      return 'Sem conexão com o servidor de autenticação.';
    case 'auth/user-disabled':
      return 'Conta desativada. Fale com o administrador.';
    default:
      return `Falha no login (${codigo}).`;
  }
}
