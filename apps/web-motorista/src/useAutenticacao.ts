import { useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { clearIndexedDbPersistence, terminate, waitForPendingWrites } from 'firebase/firestore';
import { auth, db } from './firebase';

/**
 * Sair LIMPA o que ficou no aparelho — rota, clientes (nome, telefone,
 * endereço) e fotos de fachada. Num celular compartilhado, o próximo motorista
 * via tudo isso no cache, onde as rules não alcançam. Mas só limpa com tudo
 * ENVIADO: apagar a fila offline com confirmações pendentes perderia entregas.
 */
async function sairLimpando(): Promise<void> {
  const enviado = navigator.onLine
    ? await Promise.race([
        waitForPendingWrites(db).then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
      ])
    : false;
  if (!enviado) {
    const seguir = window.confirm(
      'Há registros ainda NÃO enviados (sem internet agora). Saindo, eles ficam guardados ' +
        'neste aparelho e sobem quando você entrar de novo com rede — mas os dados da rota ' +
        'também ficam no aparelho. Sair assim mesmo?',
    );
    if (!seguir) return;
    await signOut(auth);
    return;
  }
  await signOut(auth);
  await terminate(db);
  await clearIndexedDbPersistence(db).catch(() => undefined);
  if ('caches' in window) {
    await Promise.all(['fotos-referencia', 'fotos-referencia-meta'].map((c) => caches.delete(c)));
  }
  // O SDK do Firestore foi encerrado: só uma página nova o recria. É o
  // motorista que pediu para sair — nada recarrega no meio do trabalho.
  location.reload();
}

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
    sair: sairLimpando,
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
      return 'Conta desativada. Fale com o Admin Estoque.';
    default:
      return `Falha no login (${codigo}).`;
  }
}
