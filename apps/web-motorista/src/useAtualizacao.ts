import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * Atualização do app (PWA).
 *
 * O DEFEITO que isto conserta: nenhum dos apps chamava `registerSW`. O service
 * worker era registrado pelo script injetado, mas NADA avisava a página de que
 * existia versão nova — e service worker não é contornável por Ctrl+Shift+R (o
 * recarregamento forçado pula o cache HTTP, não o SW). Na prática o app servia a
 * versão antiga do próprio cache com o servidor já atualizado. Aconteceu duas
 * vezes nesta operação.
 *
 * Duas decisões que se equilibram:
 *
 * O SW CONTINUA EM `autoUpdate` — ele assume assim que instala. Trocar para
 * `prompt` parecia mais elegante, mas criava uma armadilha de transição: o SW
 * já instalado nos aparelhos é do modo antigo, o novo ficaria em espera, e
 * quem estivesse com o app aberto precisaria limpar o cache à mão MAIS UMA VEZ
 * para entrar no esquema novo. Com autoUpdate a troca acontece sozinha.
 *
 * MAS A PÁGINA NÃO RECARREGA SOZINHA. O SW novo assume os assets; o código em
 * execução continua sendo o velho até um reload. Recarregar automaticamente
 * perderia o que o motorista acabou de digitar no comprovante, na porta do
 * cliente. Então a faixa aparece e ele escolhe a hora — mas ele SABE, que era o
 * que faltava.
 */
const INTERVALO_CHECAGEM_MS = 30 * 60 * 1000;

export function useAtualizacao() {
  const [temAtualizacao, setTemAtualizacao] = useState(false);
  /**
   * Havia SW no controle quando a página abriu? Sem isto, a PRIMEIRA instalação
   * (que também dispara `controllerchange`) anunciaria "nova versão" para quem
   * acabou de abrir o app pela primeira vez.
   */
  const jaTinhaControlador = useRef(
    typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller),
  );

  useEffect(() => {
    // O timer nasce DEPOIS do registro (callback assíncrono), então a limpeza
    // precisa alcançá-lo por referência: sem isto o `setInterval` escapava do
    // cleanup e sobrevivia a cada remontagem — dois efeitos no StrictMode já
    // deixam dois timers checando atualização para sempre.
    let timer: ReturnType<typeof setInterval> | null = null;
    let vivo = true;

    registerSW({
      immediate: true,
      onRegisteredSW(_url, registro) {
        // O registro resolve fora do ciclo do efeito: se ele já foi desmontado,
        // criar o timer aqui seria criar um timer órfão.
        if (!registro || !vivo) return;
        // O app fica aberto o dia inteiro: sem checagem periódica, versão nova
        // só seria notada na próxima abertura fria. Falha de update não pode
        // virar erro visível para quem está entregando.
        timer = setInterval(() => {
          if (navigator.onLine) void registro.update().catch(() => {});
        }, INTERVALO_CHECAGEM_MS);
      },
    });

    const aoTrocarControlador = () => {
      if (jaTinhaControlador.current) setTemAtualizacao(true);
      jaTinhaControlador.current = true;
    };
    navigator.serviceWorker?.addEventListener('controllerchange', aoTrocarControlador);

    return () => {
      vivo = false;
      if (timer) clearInterval(timer);
      navigator.serviceWorker?.removeEventListener('controllerchange', aoTrocarControlador);
    };
  }, []);

  return { temAtualizacao, aplicar: () => window.location.reload() };
}
