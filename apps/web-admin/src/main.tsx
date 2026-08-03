import React from 'react';
import ReactDOM from 'react-dom/client';
import './mapaWorker';
import '@fontsource/archivo-black';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@rota/shared/tokens.css';
import './estilos.css';
import { App } from './App';
import { LimiteDeErro } from './LimiteDeErro';

// Última linha de defesa: sem ninguém pegando a exceção, o React desmonta a
// árvore inteira e a aba fica PRETA — sem mensagem, sem pista, no meio do
// expediente. Um erro qualquer vira aviso legível em vez de tela apagada.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LimiteDeErro oQue="O painel" isolado={false}>
      <App />
    </LimiteDeErro>
  </React.StrictMode>,
);
