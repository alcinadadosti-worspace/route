import { useEffect, useRef, useState } from 'react';
import type { ConfigGeral, MapaOffline } from '@rota/shared';
import { ativarMapaOffline, baixarMapa } from './mapaOffline';

export interface EstadoMapaOffline {
  /**
   * A verificação do OPFS na abertura terminou. Antes disso o mapa não deve
   * montar: montaria com o fallback online e piscaria ao trocar de estilo —
   * offline, ainda pediria tiles OSM à toa.
   */
  pronto: boolean;
  /** Versão ativa no OPFS — null enquanto não houver mapa embarcado íntegro. */
  versaoInstalada: string | null;
  /** Versão publicada em config/geral quando difere da instalada. */
  atualizacao: MapaOffline | null;
  /** Fração 0–1 durante o download; null fora dele. */
  baixando: number | null;
  erro: string | null;
  baixar: () => void;
}

/**
 * Ciclo de vida do mapa embarcado (seção 12, camada 3): ativa o que existe
 * no OPFS na abertura, compara com a versão publicada e conduz o download.
 */
export function useMapaOffline(config: ConfigGeral | null): EstadoMapaOffline {
  const [pronto, setPronto] = useState(false);
  const [versaoInstalada, setVersaoInstalada] = useState<string | null>(null);
  const [baixando, setBaixando] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const baixandoRef = useRef(false);

  useEffect(() => {
    void ativarMapaOffline().then((versao) => {
      setVersaoInstalada(versao);
      setPronto(true);
    });
  }, []);

  const publicado = config?.mapa ?? null;
  const atualizacao = publicado && publicado.versao !== versaoInstalada ? publicado : null;

  function baixar() {
    if (!atualizacao || baixandoRef.current) return;
    baixandoRef.current = true;
    setErro(null);
    setBaixando(0);
    let ultimaFracao = 0;
    baixarMapa(atualizacao, (fracao) => {
      // Um re-render por ponto percentual, não por chunk da rede.
      if (fracao - ultimaFracao >= 0.01 || fracao === 1) {
        ultimaFracao = fracao;
        setBaixando(fracao);
      }
    })
      .then(() => ativarMapaOffline())
      .then((versao) => setVersaoInstalada(versao))
      .catch((causa: unknown) => {
        setErro(causa instanceof Error ? causa.message : 'Falha no download');
      })
      .finally(() => {
        baixandoRef.current = false;
        setBaixando(null);
      });
  }

  return { pronto, versaoInstalada, atualizacao, baixando, erro, baixar };
}
