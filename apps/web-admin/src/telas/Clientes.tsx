import { useEffect, useState } from 'react';
import type { Cliente } from '@rota/shared';
import { listarClientes } from '../api';

const ROTULO_MAPEAMENTO: Record<string, { texto: string; classe: string }> = {
  nao_mapeado: { texto: 'Não mapeado', classe: 'pendente' },
  geocodificado: { texto: 'Geocodificado', classe: '' },
  mapeado: { texto: 'Mapeado', classe: 'pronto' },
};

export function Clientes() {
  const [clientes, setClientes] = useState<Array<{ id: string } & Cliente>>([]);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    listarClientes()
      .then(setClientes)
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao listar'));
  }, []);

  return (
    <section className="cartao">
      <h2>Clientes</h2>
      {erro && <div className="erro">{erro} — a API está no ar? (npm run dev:api)</div>}
      {!erro && clientes.length === 0 && (
        <div className="vazio">Nenhum cliente ainda — eles nascem da importação das notas.</div>
      )}
      {clientes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Documento</th>
              <th>Telefone</th>
              <th>Endereço fiscal</th>
              <th>Mapeamento</th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => {
              const s = ROTULO_MAPEAMENTO[c.statusMapeamento] ?? {
                texto: c.statusMapeamento,
                classe: '',
              };
              const e = c.enderecoFiscal;
              return (
                <tr key={c.id}>
                  <td>{c.nome}</td>
                  <td className="mono">{c.documentoMascarado}</td>
                  <td className="mono">{c.telefone ?? '—'}</td>
                  <td>
                    {e.logradouro}, {e.numero} — {e.bairro}, {e.municipio}/{e.uf}
                  </td>
                  <td>
                    <span className={`chip ${s.classe}`}>{s.texto}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
