import { useEffect, useRef, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { deveEnviarPosicao, type PosicaoMotorista } from '@rota/shared';
import { db } from './firebase';
import type { LeituraGps } from './usePosicao';

/**
 * Compartilha a posição com o escritório enquanto a rota está em execução
 * (seção 11.4). Responde três perguntas que hoje ficam sem resposta: "cadê
 * ele?", "o cliente ligou, quando chega?" e "sumiu, está tudo bem?".
 *
 * Três decisões que o motorista não deveria pagar:
 *
 * 1. NÃO liga GPS próprio. Consome a leitura que a tela já tem — durante a
 *    navegação o `watchPosition` está ligado de qualquer jeito. Um segundo
 *    watch seria o dobro de bateria pelo mesmo dado.
 * 2. Escreve num doc à parte (`posicoes/{rotaId}`), nunca no doc da rota: o
 *    app escuta a própria rota em tempo real, e gravar ali dispararia uma
 *    leitura no celular DELE a cada atualização, repintando a tela no meio do
 *    trabalho.
 * 3. PARA sozinho quando a rota conclui. Fora do expediente ninguém é seguido,
 *    e isso não pode depender de alguém lembrar de desligar.
 *
 * A escrita vai pela fila offline do Firestore: sem sinal ela espera e sobe
 * depois — e como o doc é sempre o mesmo, o que chega é a posição mais recente,
 * não um rastro velho.
 */
export function useCompartilharPosicao(
  rota: { id: string; status: string } | null,
  leitura: LeituraGps | null,
  uid: string | null,
): { compartilhando: boolean; ultimoEnvio: number | null } {
  const ultimaRef = useRef<{ ponto: { lat: number; lng: number }; emMs: number } | null>(null);
  const [ultimoEnvio, setUltimoEnvio] = useState<number | null>(null);

  const ativo = Boolean(rota && uid && rota.status === 'em_execucao');

  // Rota trocou (ou acabou): zera a referência para a próxima começar limpa,
  // senão o primeiro envio da rota nova seria comparado com a posição da velha.
  useEffect(() => {
    ultimaRef.current = null;
    setUltimoEnvio(null);
  }, [rota?.id, ativo]);

  useEffect(() => {
    if (!ativo || !leitura || !rota || !uid) return;
    const agoraMs = leitura.t || Date.now();
    const ponto = { lat: leitura.lat, lng: leitura.lng };
    if (!deveEnviarPosicao(ultimaRef.current, ponto, agoraMs)) return;

    const posicao: PosicaoMotorista = {
      lat: leitura.lat,
      lng: leitura.lng,
      precisaoM: Math.round(leitura.precisaoM),
      rumo: leitura.rumoGps,
      velocidadeMs: null,
      em: new Date(agoraMs).toISOString(),
      motoristaId: uid,
    };
    // Marca ANTES de esperar a rede: a escrita vai para a fila offline e pode
    // demorar. Sem isto, cada leitura nova reenviaria enquanto a anterior não
    // resolvesse — e sem sinal isso vira uma fila de posições repetidas.
    ultimaRef.current = { ponto, emMs: agoraMs };
    setUltimoEnvio(agoraMs);
    setDoc(doc(db, 'posicoes', rota.id), posicao).catch((erro) =>
      console.error('Falha ao compartilhar posição', erro),
    );
  }, [leitura, ativo, rota, uid]);

  return { compartilhando: ativo, ultimoEnvio };
}
