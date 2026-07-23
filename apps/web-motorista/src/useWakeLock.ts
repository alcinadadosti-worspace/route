import { useEffect } from 'react';

/**
 * Tela sempre ativa (RF-20): segura um Screen Wake Lock enquanto `ativo` —
 * navegação e gravação acontecem de tela ligada por desenho (seção 11.5).
 * O sistema solta o lock quando o app vai para segundo plano; ao voltar,
 * o listener de visibilidade readquire.
 */
export function useWakeLock(ativo: boolean): void {
  useEffect(() => {
    if (!ativo || !('wakeLock' in navigator)) return;

    let sentinela: WakeLockSentinel | null = null;
    let cancelado = false;

    async function obter() {
      // Lock ainda vigente: pedir outro por cima vazaria o anterior.
      if (sentinela && !sentinela.released) return;
      try {
        sentinela = await navigator.wakeLock.request('screen');
        if (cancelado) await sentinela.release();
      } catch {
        // Sem suporte ou economia de energia agressiva: o app segue funcionando;
        // o suporte veicular com carregador (RNF-03) é a mitigação operacional.
      }
    }

    function aoMudarVisibilidade() {
      if (document.visibilityState === 'visible') void obter();
    }

    void obter();
    document.addEventListener('visibilitychange', aoMudarVisibilidade);
    return () => {
      cancelado = true;
      document.removeEventListener('visibilitychange', aoMudarVisibilidade);
      sentinela?.release().catch(() => {});
    };
  }, [ativo]);
}
