import { useEffect, useState, type ChangeEvent } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import type { Cliente } from '@rota/shared';
import { db, storage } from './firebase';
import { enfileirarFoto, redimensionarFoto } from './servicoFotos';

/**
 * Dossiê do local (RF-21): foto da fachada/referência e observação livre,
 * vinculadas ao CLIENTE — qualquer motorista que navegar até lá vê. Junto de
 * pin e trilha, completam o conhecimento do local.
 */
export function DossieLocal({ cliente }: { cliente: { id: string } & Cliente }) {
  const [observacoes, setObservacoes] = useState(cliente.observacoes);
  const [fotoNaFila, setFotoNaFila] = useState(false);

  const [erroFoto, setErroFoto] = useState(false);

  async function aoEscolherFoto(evento: ChangeEvent<HTMLInputElement>) {
    const arquivo = evento.target.files?.[0];
    // Limpa o input: escolher o mesmo arquivo de novo deve disparar o change.
    evento.target.value = '';
    if (!arquivo) return;
    setErroFoto(false);
    try {
      const reduzida = await redimensionarFoto(arquivo);
      await enfileirarFoto(cliente.id, reduzida);
      setFotoNaFila(true);
      navigator.vibrate?.(80);
    } catch (erro) {
      // Aparelho sem OPFS/canvas: melhor avisar do que perder a foto calado.
      console.error('Falha ao guardar a foto', erro);
      setErroFoto(true);
    }
  }

  function salvarObservacoes() {
    // Fila offline do Firestore, como toda escrita de campo.
    updateDoc(doc(db, 'clientes', cliente.id), { observacoes }).catch((erro) =>
      console.error('Falha ao sincronizar observações', erro),
    );
    navigator.vibrate?.(80);
  }

  const temFoto = Boolean(cliente.fotoReferenciaPath) || fotoNaFila;

  return (
    <div className="dossie">
      {cliente.fotoReferenciaPath && (
        <FotoReferencia caminho={cliente.fotoReferenciaPath} alt={`Referência de ${cliente.nome}`} />
      )}
      {fotoNaFila && !cliente.fotoReferenciaPath && (
        <div className="dossie-fila">📷 Foto guardada — sobe quando houver rede</div>
      )}
      {erroFoto && (
        <div className="dossie-fila">⚠ Não deu para guardar a foto neste aparelho — tente de novo</div>
      )}
      <label className="foto-botao">
        📷 {temFoto ? 'Trocar foto de referência' : 'Fotografar referência do local'}
        <input type="file" accept="image/*" capture="environment" hidden onChange={aoEscolherFoto} />
      </label>
      <textarea
        className="dossie-obs"
        value={observacoes}
        onChange={(e) => setObservacoes(e.target.value)}
        placeholder="Observações do local (portão azul, entrar pela lateral…)"
        rows={2}
      />
      {observacoes !== cliente.observacoes && (
        <button className="dossie-salvar" onClick={salvarObservacoes}>
          Salvar observações
        </button>
      )}
    </div>
  );
}

/**
 * Miniatura da foto de referência. A resolução da URL passa pelo service
 * worker (cache do Storage), então funciona offline depois da primeira
 * visualização; se falhar sem rede, tenta de novo quando ela voltar.
 */
export function FotoReferencia({ caminho, alt }: { caminho: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let ativo = true;
    const resolver = () => {
      getDownloadURL(ref(storage, caminho))
        .then((u) => {
          if (ativo) setUrl(u);
        })
        .catch(() => {});
    };
    resolver();
    window.addEventListener('online', resolver);
    return () => {
      ativo = false;
      window.removeEventListener('online', resolver);
    };
  }, [caminho]);

  if (!url) return null;
  return <img className="foto-referencia" src={url} alt={alt} loading="lazy" />;
}
