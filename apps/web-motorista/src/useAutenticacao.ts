import { useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from './firebase';

/** Sessão do motorista — login por e-mail/senha, contas criadas pelo admin (seção 2). */
export function useAutenticacao() {
  const [usuario, setUsuario] = useState<User | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUsuario(u);
        setCarregando(false);
      }),
    [],
  );

  return {
    usuario,
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
      return 'Sem conexão. Tente no Wi-Fi da base.';
    case 'auth/user-disabled':
      return 'Conta desativada. Fale com o escritório.';
    default:
      return `Falha no login (${codigo}).`;
  }
}
