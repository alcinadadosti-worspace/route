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
    const hoje = new Intl.DateTimeFormat('en-CA').format(new Date());
    const consulta = query(
      collection(db, 'rotas'),
      where('motoristaId', '==', uid),
      where('data', '==', hoje),
    );
    return onSnapshot(
      consulta,
      (resposta) => {
        const rotas = resposta.docs
          .map((d) => ({ id: d.id, ...(d.data() as Rota) }))
          .filter((r) => r.status === 'publicada' || r.status === 'em_execucao')
          .sort((a, b) => (b.publicadaEm ?? '').localeCompare(a.publicadaEm ?? ''));
        setRota(rotas[0] ?? null);
        setCarregando(false);
      },
      () => setCarregando(false),
    );
  }, [uid]);

  return { rota, carregando };
}
