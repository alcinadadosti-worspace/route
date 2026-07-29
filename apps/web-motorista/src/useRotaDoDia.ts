import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { Rota } from '@rota/shared';
import { db } from './firebase';

/**
 * Rota do dia do motorista logado (RF-16): assinatura em tempo real da rota
 * publicada para ele com a data de hoje. Com o cache persistente, a última
 * resposta continua disponível offline.
 */
export function useRotaDoDia(uid: string | null) {
  const [rota, setRota] = useState<({ id: string } & Rota) | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    if (!uid) {
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
        const rotas = resposta.docs
          .map((d) => ({ id: d.id, ...(d.data() as Rota) }))
          .filter((r) => r.status !== 'rascunho');
        // A rota ATIVA mais recente (a do dia quando existe; senão a de ontem
        // ainda em andamento). Sem nenhuma ativa, a mais recente já concluída —
        // ao fim do dia o motorista continua vendo o resumo do que fez.
        const ativas = rotas.filter((r) => r.status !== 'concluida');
        const candidatas = ativas.length > 0 ? ativas : rotas;
        candidatas.sort(
          (a, b) =>
            b.data.localeCompare(a.data) ||
            // Empate na data: a rota JÁ INICIADA vem primeiro. Publicar a
            // segunda rota do dia não pode esconder a que o motorista está no
            // meio de executar (com paradas entregues e o resto por entregar).
            // A data continua mandando antes disso, senão uma rota de ontem
            // esquecida em execução seguraria a de hoje para sempre.
            Number(b.status === 'em_execucao') - Number(a.status === 'em_execucao') ||
            (b.publicadaEm ?? '').localeCompare(a.publicadaEm ?? ''),
        );
        setRota(candidatas[0] ?? null);
        setCarregando(false);
      },
      () => setCarregando(false),
    );
  }, [uid]);

  return { rota, carregando };
}
