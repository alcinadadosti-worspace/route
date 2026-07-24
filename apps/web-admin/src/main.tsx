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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
