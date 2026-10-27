import { useEffect, useState } from 'react';
import { atividadesEmCurso, ouvirAtividade } from './atividade';

/** O giro pequeno com o texto do botão ("APAGANDO…"). */
export function Girando({ texto }: { texto: string }) {
  return (
    <>
      <span className="giro pequeno" aria-hidden="true" />
      {texto}
    </>
  );
}

/**
 * Aviso no topo do painel enquanto alguma ação espera o servidor. Só aparece
 * depois de 300 ms: a ação rápida não pisca a tela.
 */
export function BarraDeAtividade() {
  const [emCurso, setEmCurso] = useState(atividadesEmCurso());
  const [visivel, setVisivel] = useState(false);
  useEffect(() => ouvirAtividade(setEmCurso), []);
  useEffect(() => {
    if (emCurso === 0) {
      setVisivel(false);
      return;
    }
    const espera = setTimeout(() => setVisivel(true), 300);
    return () => clearTimeout(espera);
  }, [emCurso]);
  if (!visivel) return null;
  return (
    <div className="barra-atividade" role="status" aria-live="polite">
      <div className="barra-indeterminada" aria-hidden="true">
        <span />
      </div>
      <div className="aviso-atividade">
        <span className="giro pequeno" aria-hidden="true" />
        Processando…
      </div>
    </div>
  );
}
