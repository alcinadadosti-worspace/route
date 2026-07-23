import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import type { Cliente, Rota, Trilha } from '@rota/shared';
import { db } from './firebase';

export interface DossieCliente {
  cliente: ({ id: string } & Cliente) | null;
  /** Trilha ativa aprendida — o trecho fora da malha até a porta (seção 7.4). */
  trilha: ({ id: string } & Trilha) | null;
}

/**
 * Dossiê dos clientes da rota (RF-16/RF-21): assina os docs de cliente e a
 * trilha ativa de cada parada. Estas leituras SÃO a pré-carga offline da
 * camada 2 (seção 12): feitas ainda no Wi-Fi da base, ficam no cache
 * persistente e respondem em campo sem rede.
 */
export function useClientesDaRota(
  rota: ({ id: string } & Rota) | null,
): Record<string, DossieCliente> {
  const [dossies, setDossies] = useState<Record<string, DossieCliente>>({});

  const clienteIds = useMemo(
    () => [...new Set(rota?.paradas.map((p) => p.clienteId) ?? [])].sort(),
    [rota],
  );
  const chave = clienteIds.join('|');

  useEffect(() => {
    if (!clienteIds.length) {
      setDossies({});
      return;
    }

    const cancelamentos: Array<() => void> = [];
    for (const clienteId of clienteIds) {
      let cancelarTrilha: (() => void) | null = null;
      let trilhaAssinada: string | null = null;

      const cancelarCliente = onSnapshot(doc(db, 'clientes', clienteId), (snap) => {
        const cliente = snap.exists() ? { id: snap.id, ...(snap.data() as Cliente) } : null;
        setDossies((d) => ({
          ...d,
          [clienteId]: { cliente, trilha: d[clienteId]?.trilha ?? null },
        }));

        const trilhaId = cliente?.trilhaAtivaId ?? null;
        if (trilhaId === trilhaAssinada) return;
        cancelarTrilha?.();
        trilhaAssinada = trilhaId;
        if (!trilhaId) {
          cancelarTrilha = null;
          setDossies((d) => ({ ...d, [clienteId]: { cliente, trilha: null } }));
          return;
        }
        cancelarTrilha = onSnapshot(doc(db, 'trilhas', trilhaId), (t) => {
          setDossies((d) => ({
            ...d,
            [clienteId]: {
              cliente: d[clienteId]?.cliente ?? null,
              trilha: t.exists() ? { id: t.id, ...(t.data() as Trilha) } : null,
            },
          }));
        });
      });

      cancelamentos.push(() => {
        cancelarCliente();
        cancelarTrilha?.();
      });
    }
    return () => cancelamentos.forEach((cancelar) => cancelar());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  return dossies;
}
