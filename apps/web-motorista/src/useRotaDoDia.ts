import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { Rota } from '@rota/shared';
import { db } from './firebase';
import { escolherRotaAtiva, rotasAbertasEmEspera } from './rotaAtiva';

/**
 * Rota do dia do motorista logado (RF-16): assinatura em tempo real da rota
 * publicada para ele com a data de hoje. Com o cache persistente, a última
 * resposta continua disponível offline.
 */
export function useRotaDoDia(uid: string | null) {
  const [rota, setRota] = useState<({ id: string } & Rota) | null>(null);
  /**
   * Outras rotas ABERTAS dele que não estão na tela. O app mostra uma só; sem
   * este aviso, uma segunda rota publicada no meio do dia ficava invisível com
   * os pedidos presos em `em_rota`, e ninguém percebia.
   */
  const [emEspera, setEmEspera] = useState<Array<{ id: string } & Rota>>([]);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    if (!uid) {
      setRota(null);
      setEmEspera([]);
      setCarregando(false);
      return;
    }
    // Janela dos últimos dias no fuso da publicação. NÃO filtra "data == hoje":
    // uma rota EM ANDAMENTO iniciada ontem tem de continuar aparecendo hoje, e
    // uma sessão aberta atravessando a meia-noite não pode congelar no dia
    // anterior. `data >=` reaproveita o índice (motoristaId, data) do == antigo.
    const limite = new Date();
    limite.setDate(limite.getDate() - 7);
    const desde = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Maceio' }).format(limite);
    const consulta = query(
      collection(db, 'rotas'),
      where('motoristaId', '==', uid),
      where('data', '>=', desde),
    );
    return onSnapshot(
      consulta,
      (resposta) => {
        const rotas = resposta.docs.map((d) => ({ id: d.id, ...(d.data() as Rota) }));
        // A regra de escolha vive em `rotaAtiva.ts`, com teste: é ela que
        // decide o que acontece quando existe mais de uma rota aberta.
        const escolhida = escolherRotaAtiva(rotas);
        setRota(escolhida);
        setEmEspera(rotasAbertasEmEspera(rotas, escolhida));
        setCarregando(false);
      },
      () => setCarregando(false),
    );
  }, [uid]);

  return { rota, emEspera, carregando };
}
