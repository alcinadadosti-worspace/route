import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import type { ConfigGeral } from '@rota/shared';
import { db } from './firebase';

/**
 * config/geral (seção 7.6) — assinado logo após o login, o que também é a
 * pré-carga da camada 2: a versão corrente do mapa fica no cache persistente
 * e responde offline.
 */
export function useConfigGeral(uid: string | null): ConfigGeral | null {
  const [config, setConfig] = useState<ConfigGeral | null>(null);

  useEffect(() => {
    if (!uid) {
      setConfig(null);
      return;
    }
    return onSnapshot(doc(db, 'config', 'geral'), (resposta) => {
      setConfig(resposta.exists() ? (resposta.data() as ConfigGeral) : null);
    });
  }, [uid]);

  return config;
}
