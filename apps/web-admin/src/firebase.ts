import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { firebaseConfig } from '@rota/shared';

export const auth = getAuth(initializeApp(firebaseConfig));
