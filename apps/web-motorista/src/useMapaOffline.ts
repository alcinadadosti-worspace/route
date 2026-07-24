import { useEffect, useRef, useState } from 'react';
import type { ConfigGeral, MapaOffline } from '@rota/shared';
import { ativarMapaOffline, baixarMapa, mapaConfigValido } from './mapaOffline';

export interface EstadoMapaOffline {
  /**
   * A verificação do OPFS na abertura terminou. Antes disso nada de mapa deve
   * ser mostrado nem oferecido para download: sem saber o que está instalado,
   * o app ofereceria "baixar" um mapa que já existe (re-download de dezenas
   * de MB) e montaria o basemap online à toa.
   */
  pronto: boolean;
  /** Versão ativa no OPFS — null enquanto não houver mapa embarcado íntegro. */
  versaoInstalada: string | null;
  /** URL de fonte pmtiles da versão instalada — null quando não há mapa. */
  urlFonte: string | null;
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
  const [urlFonte, setUrlFonte] = useState<string | null>(null);
  const [baixando, setBaixando] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const baixandoRef = useRef(false);

  useEffect(() => {
    void ativarMapaOffline().then((instalado) => {
      setVersaoInstalada(instalado?.versao ?? null);
      setUrlFonte(instalado?.urlFonte ?? null);
      setPronto(true);
    });
  }, []);

  // Só oferece o que a publicação traz com forma válida (tamanho > 0 etc.):
  // config corrompida não deve virar "NaN MB" nem um download que sempre falha.
  const publicado = mapaConfigValido(config?.mapa) ? config!.mapa! : null;
  const atualizacao = publicado && publicado.versao !== versaoInstalada ? publicado : null;

  // Erro pertence à última tentativa; quando a versão publicada muda, ele
  // deixa de ser relevante (era de outra versão) e é limpo.
  useEffect(() => {
    setErro(null);
  }, [publicado?.versao]);

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
      .then((instalado) => {
        setVersaoInstalada(instalado?.versao ?? null);
        setUrlFonte(instalado?.urlFonte ?? null);
      })
      .catch((causa: unknown) => {
        setErro(causa instanceof Error ? causa.message : 'Falha no download');
      })
      .finally(() => {
        baixandoRef.current = false;
        setBaixando(null);
      });
  }

  return { pronto, versaoInstalada, urlFonte, atualizacao, baixando, erro, baixar };
}
