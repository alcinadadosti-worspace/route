import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { Rota } from '@rota/shared';
import { db } from './firebase';
import { escolherRotaAtiva } from './rotaAtiva';

/**
 * Rota do dia do motorista logado (RF-16): assinatura em tempo real da rota
 * publicada para ele com a data de hoje. Com o cache persistente, a última
 * resposta continua disponível offline.
 */
export function useRotaDoDia(uid: string | null) {
  /**
   * TODAS as rotas da janela — abertas e fechadas. O app mostra uma por vez,
   * mas quem escolhe é o motorista: ele tem abas de abertas e de fechadas.
   * `rota` é só a escolha PADRÃO, para ele não ter de escolher nada no dia
   * normal de uma rota só.
   */
  const [rotas, setRotas] = useState<Array<{ id: string } & Rota>>([]);
  const [rota, setRota] = useState<({ id: string } & Rota) | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    if (!uid) {
      setRotas([]);
      setRota(null);
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
        const todas = resposta.docs
          .map((d) => ({ id: d.id, ...(d.data() as Rota) }))
          .filter((r) => r.status !== 'rascunho');
        setRotas(todas);
        // A regra de escolha vive em `rotaAtiva.ts`, com teste: é ela que
        // decide qual rota abre sozinha quando há mais de uma.
        setRota(escolherRotaAtiva(todas));
        setCarregando(false);
      },
      () => setCarregando(false),
    );
  }, [uid]);

  return { rotas, rota, carregando };
}
