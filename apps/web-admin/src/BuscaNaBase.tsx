import { useEffect, useState } from 'react';
import { telefoneLegivel, type RevendedoraCandidata } from '@rota/shared';
import { buscarNaBase, contarBase } from './api';
import { Girando } from './Carregando';

/**
 * A base de revendedoras dentro da aba Clientes. A lista de Clientes só tem
 * quem já teve pedido; a base (os cadastros e as planilhas de pedidos, 40 mil
 * pessoas, inclusive inativas) fica à parte — listada inteira, cada abertura
 * da aba leria 40 mil documentos. Por isso aqui é por BUSCA: nome que começa
 * com o que se digita, ou o código.
 */
export function BuscaNaBase({ clientesNaLista }: { clientesNaLista: number }) {
  const [total, setTotal] = useState<number | null>(null);
  const [termo, setTermo] = useState('');
  const [resultados, setResultados] = useState<RevendedoraCandidata[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    contarBase()
      .then(setTotal)
      .catch(() => setTotal(null));
  }, []);

  async function buscar() {
    const t = termo.trim();
    if (t.replace(/\s/g, '').length < 3) {
      setErro('Digite pelo menos 3 letras do nome (ou o código).');
      return;
    }
    setBuscando(true);
    setErro(null);
    try {
      setResultados(await buscarNaBase(t));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha na busca');
    } finally {
      setBuscando(false);
    }
  }

  return (
    <div className="busca-base">
      <div className="decisao-rotulo">Base de revendedoras</div>
      <p className="decisao-aviso">
        A lista abaixo tem só quem já teve pedido ({clientesNaLista}). A base guarda{' '}
        {total !== null ? <strong>{total.toLocaleString('pt-BR')}</strong> : 'todas as'} pessoas dos cadastros e das
        planilhas de pedidos, inclusive inativas — é com ela que cada romaneio é cruzado. Busque pelo começo do nome
        ou pelo código:
      </p>
      <form
        className="busca-base-linha"
        onSubmit={(e) => {
          e.preventDefault();
          void buscar();
        }}
      >
        <input
          type="search"
          className="filtro"
          placeholder="Ex.: MARIA JOSE DA SILVA ou 25405384"
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
        />
        <button type="submit" disabled={buscando}>
          {buscando ? <Girando texto="BUSCANDO…" /> : 'BUSCAR NA BASE'}
        </button>
      </form>
      {erro && <div className="erro">{erro}</div>}
      {resultados?.length === 0 && <div className="vazio">Ninguém na base começa com “{termo}”.</div>}
      {resultados && resultados.length > 0 && (
        <div className="rolagem-tabela">
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Nome</th>
                <th>Endereço</th>
                <th>Telefone</th>
                <th>Situação</th>
                <th>Dado de</th>
              </tr>
            </thead>
            <tbody>
              {resultados.map((r) => (
                <tr key={r.codigo}>
                  <td className="mono">{r.codigo}</td>
                  <td>
                    {r.nome}
                    {r.papel ? <span className="decisao-aviso"> · {r.papel}</span> : null}
                  </td>
                  <td>
                    {r.endereco}
                    {r.referencia ? <div className="decisao-aviso">{r.referencia}</div> : null}
                  </td>
                  <td className="mono">{telefoneLegivel(r.telefone) ?? '—'}</td>
                  <td>{r.situacao ?? '—'}</td>
                  <td className="mono">{r.dadosDe ? `pedido ${dataCurta(r.dadosDe)}` : 'cadastro'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {resultados.length >= 50 && (
            <div className="decisao-aviso">Mostrando os 50 primeiros — escreva mais do nome para afinar.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** "2026-09-01T…" → "01/09/2026", sem passar pelo fuso do navegador. */
function dataCurta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
