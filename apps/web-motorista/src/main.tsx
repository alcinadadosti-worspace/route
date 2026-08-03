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

// Última linha de defesa. Sem isto, qualquer exceção não tratada desmonta a
// árvore e o motorista fica com a tela PRETA na porta do cliente, sem saber se
// o que ele confirmou foi salvo (foi: a fila offline do Firestore já guardou).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LimiteDeErro oQue="O aplicativo" isolado={false}>
      <App />
    </LimiteDeErro>
  </React.StrictMode>,
);
