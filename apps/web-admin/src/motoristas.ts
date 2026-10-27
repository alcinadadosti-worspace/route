import type { Usuario } from '@rota/shared';

/**
 * Quem pode receber uma rota: só MOTORISTA ativo. A lista mostrava todo
 * usuário ativo — o próprio Admin Estoque ("logistica vd penedo, admin")
 * aparecia ao lado do motorista, e uma rota publicada para ele não chegava a
 * celular nenhum.
 */
export function motoristasParaRota<U extends Pick<Usuario, 'papel' | 'ativo'>>(usuarios: U[]): U[] {
  return usuarios.filter((u) => u.ativo && u.papel === 'motorista');
}
