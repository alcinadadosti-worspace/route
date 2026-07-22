import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache } from 'firebase/firestore';
import { firebaseConfig } from '@rota/shared';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

/**
 * Firestore com cache local persistente (seção 12, camada 2): é o que permite
 * ao app responder do aparelho quando a rede some — a pré-carga da rota
 * publicada acontece por estas mesmas leituras, ainda no Wi-Fi da base.
 */
export const db = initializeFirestore(app, { localCache: persistentLocalCache() });
