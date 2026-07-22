import { useState, type FormEvent } from 'react';
import { FirebaseError } from 'firebase/app';
import { mensagemDeErroAuth } from './useAutenticacao';

export function Login({ entrar }: { entrar: (email: string, senha: string) => Promise<unknown> }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function aoEnviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      await entrar(email, senha);
    } catch (ex) {
      setErro(ex instanceof FirebaseError ? mensagemDeErroAuth(ex.code) : 'Falha no login.');
      setEnviando(false);
    }
  }

  return (
    <div className="tela-login">
      <form className="cartao-login" onSubmit={aoEnviar}>
        <h1>Rota</h1>
        <div className="sub-login">Grupo Alcina Maria · app do motorista</div>

        <label>
          E-mail
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {erro && <div className="erro-login">{erro}</div>}

        <button type="submit" className="primaria" disabled={enviando}>
          {enviando ? 'ENTRANDO…' : 'ENTRAR'}
        </button>
      </form>
    </div>
  );
}
