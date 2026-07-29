import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getStorage } from 'firebase/storage';
import { firebaseConfig } from '@rota/shared';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Fotos de referência do local (RF-21): o admin resolve o caminho no Storage
// para exibir na aba Clientes. A regra libera leitura para qualquer logado.
export const storage = getStorage(app);
