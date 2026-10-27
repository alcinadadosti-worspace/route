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
 * Aviso no topo do painel enquanto alguma ação espera o servidor. Aparece e
 * some com 300 ms de atraso: a ação rápida não pisca a tela, e entre ações em
 * sequência (as confirmações nota a nota, os lotes do Localizar) ela fica
 * acesa em vez de apagar e reacender a cada uma.
 */
export function BarraDeAtividade() {
  const [emCurso, setEmCurso] = useState(atividadesEmCurso());
  const [visivel, setVisivel] = useState(false);
  useEffect(() => ouvirAtividade(setEmCurso), []);
  useEffect(() => {
    const espera = setTimeout(() => setVisivel(emCurso > 0), 300);
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
