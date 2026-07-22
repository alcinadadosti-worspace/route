import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Papel } from '@rota/shared';

/**
 * Criação de usuários com papel (RF-27) — contas criadas apenas pelo Admin,
 * sem autocadastro (seção 2). O papel vira custom claim (fonte da verdade
 * para as security rules) e é espelhado em usuarios/{uid} para listagens.
 *
 * Uso:
 *   FIREBASE_SERVICE_ACCOUNT=... (ou GOOGLE_APPLICATION_CREDENTIALS=caminho.json)
 *   npm run criar-usuario -w @rota/api -- <email> <senha> <papel> [nome]
 *
 * papel: admin | operador | motorista
 */

const [email, senha, papel, nome] = process.argv.slice(2);

const PAPEIS: Papel[] = ['admin', 'operador', 'motorista'];

if (!email || !senha || !PAPEIS.includes(papel as Papel)) {
  console.error('Uso: criar-usuario <email> <senha> <admin|operador|motorista> [nome]');
  process.exit(1);
}

const conteudo = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!conteudo && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Defina FIREBASE_SERVICE_ACCOUNT ou GOOGLE_APPLICATION_CREDENTIALS.');
  process.exit(1);
}

const app = initializeApp({
  credential: conteudo ? cert(JSON.parse(conteudo)) : applicationDefault(),
});
const auth = getAuth(app);
const db = getFirestore(app);

let uid: string;
try {
  const existente = await auth.getUserByEmail(email);
  uid = existente.uid;
  await auth.updateUser(uid, { password: senha });
  console.log(`Usuário já existia (${uid}) — senha atualizada.`);
} catch {
  const novo = await auth.createUser({ email, password: senha, displayName: nome ?? email });
  uid = novo.uid;
  console.log(`Usuário criado: ${uid}`);
}

await auth.setCustomUserClaims(uid, { papel });
await db.collection('usuarios').doc(uid).set({
  nome: nome ?? email,
  papel,
  ativo: true,
});

console.log(`Papel '${papel}' aplicado (custom claim + usuarios/${uid}).`);
process.exit(0);
