import { useEffect, useState } from 'react';
import { getDownloadURL, ref } from 'firebase/storage';
import { storage } from './firebase';

/**
 * Miniatura da foto de referência do local (RF-21) no painel. O caminho vem no
 * cliente (`fotoReferenciaPath`); aqui resolvemos para a URL do Storage.
 */
export function FotoReferencia({ caminho, alt }: { caminho: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let ativo = true;
    // Limpa ANTES de resolver a nova: reaproveitado com outro `caminho` (a lista
    // filtrada troca quem ocupa a posição), o componente ficava mostrando a foto
    // do cliente ANTERIOR até a URL nova chegar — e aqui a foto é a referência
    // de qual casa é, então mostrar a errada engana de verdade.
    setUrl(null);
    getDownloadURL(ref(storage, caminho))
      .then((u) => ativo && setUrl(u))
      .catch(() => {});
    return () => {
      ativo = false;
    };
  }, [caminho]);

  if (!url) return null;
  return <img className="foto-referencia" src={url} alt={alt} loading="lazy" />;
}
