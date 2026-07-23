import { readFile } from 'node:fs/promises';
import { applicationDefault, cert, type Credential } from 'firebase-admin/app';

/**
 * Publica o firestore.rules e o storage.rules da raiz do repositório via
 * Firebase Rules API — mesmo caminho do `firebase deploy --only rules`, mas
 * usando a service account (sem exigir login interativo do CLI). Regras
 * testáveis no emulador entram no CI na sequência (RNF-06).
 *
 * Falha no Storage não derruba a publicação do Firestore: enquanto o bucket
 * não for provisionado no console, o script apenas avisa.
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

const cabecalhos = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};
const base = `https://firebaserules.googleapis.com/v1/projects/${projectId}`;

/** Cria um ruleset com o arquivo e aponta o release do serviço para ele. */
async function publicar(arquivo: string, servico: string): Promise<boolean> {
  const regras = await readFile(new URL(`../../../${arquivo}`, import.meta.url), 'utf8');

  const respostaRuleset = await fetch(`${base}/rulesets`, {
    method: 'POST',
    headers: cabecalhos,
    body: JSON.stringify({ source: { files: [{ name: arquivo, content: regras }] } }),
  });
  if (!respostaRuleset.ok) {
    console.error(
      `Falha ao criar ruleset de ${arquivo}:`,
      respostaRuleset.status,
      await respostaRuleset.text(),
    );
    return false;
  }
  const ruleset = (await respostaRuleset.json()) as { name: string };
  console.log('Ruleset criado:', ruleset.name);

  const nomeRelease = `projects/${projectId}/releases/${servico}`;
  let respostaRelease = await fetch(`${base}/releases/${servico}`, {
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
    console.error(
      `Falha no release ${servico}:`,
      respostaRelease.status,
      await respostaRelease.text(),
    );
    return false;
  }

  console.log(`Security rules publicadas para ${servico} ✔`);
  return true;
}

const firestoreOk = await publicar('firestore.rules', 'cloud.firestore');
const storageOk = await publicar(
  'storage.rules',
  `firebase.storage/${projectId}.firebasestorage.app`,
);
if (!storageOk) {
  console.warn(
    '⚠ Storage: publique de novo depois de provisionar o bucket no console ' +
      '(Build → Storage → Começar).',
  );
}

process.exit(firestoreOk ? 0 : 1);
