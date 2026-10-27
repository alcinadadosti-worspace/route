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
    // Só a resposta do pedido MAIS RECENTE vale: a contagem do minuto que saiu
    // antes de uma decisão e chegou depois punha o número antigo de volta.
    let ultimo = 0;
    const atualizar = () => {
      if (document.visibilityState === 'hidden') return;
      const este = ++ultimo;
      contarDecisoesPendentes()
        .then((n) => vivo && este === ultimo && setPendentes(n))
        // Sem resposta (API acordando): fica o último número, sem alarde.
        .catch(() => undefined);
    };
    atualizar();
    const relogio = setInterval(atualizar, 60_000);
    // Uma contagem por RAJADA de ações, 1 s depois da última: confirmando nota
    // a nota, eram uma contagem por nota.
    let depoisDaAcao: ReturnType<typeof setTimeout> | undefined;
    const pararDeOuvir = ouvirAtividade((emCurso) => {
      clearTimeout(depoisDaAcao);
      if (emCurso === 0) depoisDaAcao = setTimeout(atualizar, 1000);
    });
    return () => {
      vivo = false;
      clearInterval(relogio);
      clearTimeout(depoisDaAcao);
      pararDeOuvir();
    };
  }, [ativo, aba]);

  return pendentes;
}
