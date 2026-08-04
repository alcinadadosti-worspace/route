import { useState } from 'react';
import type { ResultadoEntrega } from '@rota/shared';
import { redimensionarFoto } from './servicoFotos';

/**
 * Comprovante de entrega — o passo entre "cheguei" e "confirmado".
 *
 * O Admin Estoque hoje tem só hora e GPS. Diante de um "não recebi" semanas
 * depois, isso não responde nada. O nome de quem recebeu, perguntado na porta,
 * é o que transforma discussão em consulta: é um fato que a revendedora
 * confirma ou desmente na hora.
 *
 * A FOTO é opcional na entrega e destacada no insucesso, e a razão é contra a
 * intuição: entrega feita quase nunca é contestada; o que gera briga é o
 * "cliente ausente" contra o "eu estava em casa". Uma foto do portão fechado,
 * com hora e posição, encerra essa conversa — e é também onde o custo de
 * armazenamento se justifica.
 */
export function Comprovante({
  resultado,
  nomeCliente,
  aoConfirmar,
  aoCancelar,
}: {
  resultado: ResultadoEntrega;
  nomeCliente: string;
  aoConfirmar: (dados: { recebidoPor: string | null; foto: Blob | null }) => void;
  aoCancelar: () => void;
}) {
  const [recebidoPor, setRecebidoPor] = useState('');
  const [foto, setFoto] = useState<Blob | null>(null);
  const [preparandoFoto, setPreparandoFoto] = useState(false);
  const [erroFoto, setErroFoto] = useState(false);
  const entregue = resultado === 'entregue';

  async function aoEscolherFoto(evento: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = evento.target.files?.[0];
    // Zera o input para permitir REPETIR a mesma foto depois de um erro — sem
    // isto o `change` não dispara de novo e o botão parece morto.
    evento.target.value = '';
    if (!arquivo) return;
    setPreparandoFoto(true);
    setErroFoto(false);
    try {
      setFoto(await redimensionarFoto(arquivo));
    } catch {
      setErroFoto(true);
    } finally {
      setPreparandoFoto(false);
    }
  }

  return (
    <div className="comprovante">
      {entregue ? (
        <>
          <label className="comprovante-campo">
            Quem está recebendo?
            <input
              type="text"
              value={recebidoPor}
              onChange={(e) => setRecebidoPor(e.target.value)}
              placeholder={`Ex.: ${primeiroNome(nomeCliente)}, vizinha, filho…`}
              // O limite é de REGRA: `firestore.rules` recusa nome com 120
              // caracteres ou mais, e a escrita falharia calada.
              maxLength={100}
              autoFocus
              enterKeyHint="done"
            />
          </label>
          <div className="comprovante-dica">
            Pergunte em voz alta e anote. É o que responde um “não recebi” daqui a um mês.
          </div>
        </>
      ) : (
        <div className="comprovante-dica destaque">
          📷 <strong>Tire uma foto</strong> — portão fechado, casa, o que mostrar a situação. O
          insucesso é o que mais gera reclamação, e a foto encerra a conversa.
        </div>
      )}

      <label className="foto-botao">
        📷 {foto ? 'Trocar foto' : entregue ? 'Foto (opcional)' : 'Fotografar a situação'}
        <input type="file" accept="image/*" capture="environment" hidden onChange={aoEscolherFoto} />
      </label>
      {preparandoFoto && <div className="comprovante-dica">preparando a foto…</div>}
      {foto && !preparandoFoto && <div className="comprovante-dica">✔ Foto anexada</div>}
      {erroFoto && (
        <div className="comprovante-dica">⚠ Não deu para preparar a foto — tente de novo</div>
      )}

      <div className="comprovante-acoes">
        <button
          className="confirmar"
          disabled={preparandoFoto}
          onClick={() => aoConfirmar({ recebidoPor: recebidoPor.trim() || null, foto })}
        >
          ✔ {entregue ? 'Confirmar entrega' : 'Registrar insucesso'}
        </button>
        <button onClick={aoCancelar}>Voltar</button>
      </div>
      {entregue && !recebidoPor.trim() && (
        // Não BLOQUEIA: há entrega em que não dá para anotar (deixou no
        // depósito, ninguém quis dizer o nome). Mas o motorista tem de saber o
        // que está abrindo mão.
        <div className="comprovante-dica">
          Sem nome, o comprovante fica só com hora e posição.
        </div>
      )}
    </div>
  );
}

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? 'Maria';
}
