import { useEffect, useState } from 'react';
import { contarDecisoesPendentes } from './api';
import { ouvirAtividade } from './atividade';

/**
 * Quantos pedidos esperam decisão, para o número no ícone da aba Decisões.
 * Pendência escondida numa aba que ninguém abre é pedido que não entra em rota
 * (o endereço mudou num cliente que já tinha ponto, e o sistema não decide
 * sozinho se o ponto ainda vale).
 *
 * Atualiza ao abrir, ao trocar de aba, depois de cada ação que termina
 * (importar, decidir, publicar) e a cada minuto com a aba do navegador à
 * vista. A contagem é feita no banco — não traz os pedidos.
 */
export function useDecisoesPendentes(ativo: boolean, aba: string): number | null {
  const [pendentes, setPendentes] = useState<number | null>(null);

  useEffect(() => {
    if (!ativo) return;
    let vivo = true;
    const atualizar = () => {
      if (document.visibilityState === 'hidden') return;
      contarDecisoesPendentes()
        .then((n) => vivo && setPendentes(n))
        // Sem resposta (API acordando): fica o último número, sem alarde.
        .catch(() => undefined);
    };
    atualizar();
    const relogio = setInterval(atualizar, 60_000);
    const pararDeOuvir = ouvirAtividade((emCurso) => {
      if (emCurso === 0) atualizar();
    });
    return () => {
      vivo = false;
      clearInterval(relogio);
      pararDeOuvir();
    };
  }, [ativo, aba]);

  return pendentes;
}
