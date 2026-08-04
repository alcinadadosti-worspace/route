import { useEffect, useRef, useState } from 'react';

/**
 * Atualização do app (PWA) — registro MANUAL do service worker.
 *
 * Por que não usar o `virtual:pwa-register` do plugin: em `autoUpdate` o módulo
 * embute um `addEventListener('activated', ... window.location.reload())`
 * (conferido no bundle gerado). Ou seja: a página recarregaria SOZINHA assim
 * que o SW novo ativasse — no meio de uma montagem de rota, a seleção de pedidos
 * e a prévia já otimizada iriam embora.
 * A faixa existiria para nada, porque a recarga viria antes dela.
 *
 * Então o registro é nosso: registra o /sw.js gerado (que continua em
 * autoUpdate — skipWaiting + clientsClaim, para a troca de versão acontecer
 * sem limpeza manual de cache), checa atualização a cada 30 min porque o app
 * fica aberto o dia inteiro, e quando o controlador troca levanta a FAIXA.
 * Recarregar é decisão de quem usa, no toque.
 */
const INTERVALO_CHECAGEM_MS = 30 * 60 * 1000;

export function useAtualizacao() {
  const [temAtualizacao, setTemAtualizacao] = useState(false);
  /**
   * Havia SW no controle quando a página abriu? Sem isto, a PRIMEIRA instalação
   * (que também dispara `controllerchange`, via clientsClaim) anunciaria "nova
   * versão" para quem acabou de abrir o app pela primeira vez.
   */
  const jaTinhaControlador = useRef(
    typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller),
  );

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // O timer nasce DEPOIS do registro (promessa), então a limpeza o alcança
    // por referência; `vivo` cobre o registro que resolve após a desmontagem.
    let timer: ReturnType<typeof setInterval> | null = null;
    let vivo = true;

    navigator.serviceWorker
      .register('/sw.js')
      .then((registro) => {
        if (!vivo) return;
        timer = setInterval(() => {
          // Sem rede a checagem só falharia — e falha de update não pode virar
          // erro visível no meio do trabalho do Admin Estoque.
          if (navigator.onLine) void registro.update().catch(() => {});
        }, INTERVALO_CHECAGEM_MS);
      })
      // Dev roda sem sw.js: o 404 do registro não é erro de ninguém.
      .catch(() => {});

    const aoTrocarControlador = () => {
      if (jaTinhaControlador.current) setTemAtualizacao(true);
      jaTinhaControlador.current = true;
    };
    navigator.serviceWorker.addEventListener('controllerchange', aoTrocarControlador);

    return () => {
      vivo = false;
      if (timer) clearInterval(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', aoTrocarControlador);
    };
  }, []);

  return { temAtualizacao, aplicar: () => window.location.reload() };
}
