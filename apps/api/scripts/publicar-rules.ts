import { readFile } from 'node:fs/promises';
import { applicationDefault, cert, type Credential } from 'firebase-admin/app';

/**
 * Publica o firestore.rules da raiz do repositório via Firebase Rules API —
 * mesmo caminho do `firebase deploy --only firestore:rules`, mas usando a
 * service account (sem exigir login interativo do CLI). Regras testáveis no
 * emulador entram no CI na sequência (RNF-06).
 *
 * Uso: FIREBASE_SERVICE_ACCOUNT=... (ou GOOGLE_APPLICATION_CREDENTIALS=...)
 *      npm run publicar-rules -w @rota/api
 */

const conteudoSa = process.env.FIREBASE_SERVICE_ACCOUNT;
const caminhoSa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!conteudoSa && !caminhoSa) {
  console.error('Defina FIREBASE_SERVICE_ACCOUNT ou GOOGLE_APPLICATION_CREDENTIALS.');
  process.exit(1);
}

const sa = JSON.parse(conteudoSa ?? (await readFile(caminhoSa!, 'utf8')));
const projectId: string = sa.project_id;
const credencial: Credential = conteudoSa ? cert(sa) : applicationDefault();
const token = (await credencial.getAccessToken()).access_token;

const regras = await readFile(new URL('../../../firestore.rules', import.meta.url), 'utf8');

const cabecalhos = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};
const base = `https://firebaserules.googleapis.com/v1/projects/${projectId}`;

// 1. Cria o ruleset com o conteúdo atual.
const respostaRuleset = await fetch(`${base}/rulesets`, {
  method: 'POST',
  headers: cabecalhos,
  body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: regras }] } }),
});
if (!respostaRuleset.ok) {
  console.error('Falha ao criar ruleset:', respostaRuleset.status, await respostaRuleset.text());
  process.exit(1);
}
const ruleset = (await respostaRuleset.json()) as { name: string };
console.log('Ruleset criado:', ruleset.name);

// 2. Aponta o release cloud.firestore para o novo ruleset.
const nomeRelease = `projects/${projectId}/releases/cloud.firestore`;
let respostaRelease = await fetch(`${base}/releases/cloud.firestore`, {
  method: 'PATCH',
  headers: cabecalhos,
  body: JSON.stringify({ release: { name: nomeRelease, rulesetName: ruleset.name } }),
});
if (respostaRelease.status === 404) {
  respostaRelease = await fetch(`${base}/releases`, {
    method: 'POST',
    headers: cabecalhos,
    body: JSON.stringify({ name: nomeRelease, rulesetName: ruleset.name }),
  });
}
if (!respostaRelease.ok) {
  console.error('Falha no release:', respostaRelease.status, await respostaRelease.text());
  process.exit(1);
}

console.log('Security rules publicadas para cloud.firestore ✔');
process.exit(0);
