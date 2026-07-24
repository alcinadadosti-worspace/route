import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { criarApp } from '../app.js';
import { RepositorioMemoria } from '../db/repositorio.js';
import type { Autenticador } from './autenticador.js';

// O bypass por request-target em forma absoluta (`GET http://host/api/x`) só
// aparece num socket CRU — o app.inject/light-my-request normaliza a URL antes
// do hook e mascara a falha. Por isso este teste fala HTTP na unha.
const autenticador: Autenticador = {
  async verificar() {
    return null; // sempre rejeita: qualquer rota protegida deve dar 401
  },
};

async function requisicaoCrua(porta: number, requestLine: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(porta, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let resp = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (d) => (resp += d.toString('latin1')));
    socket.on('close', () => {
      const m = resp.match(/^HTTP\/1\.\d (\d{3})/);
      resolve(m ? Number(m[1]) : 0);
    });
    socket.on('error', reject);
  });
}

test('forma absoluta do request-target NÃO burla a auth (deny-by-default)', async () => {
  const app = await criarApp({ repo: new RepositorioMemoria(), autenticador });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const porta = (app.server.address() as AddressInfo).port;
  try {
    // Sem o fix, isto voltava 200 com dados sensíveis.
    assert.equal(
      await requisicaoCrua(porta, 'GET http://evil.example/api/rotas HTTP/1.1'),
      401,
      'forma absoluta sem token tem que dar 401',
    );
    // Forma origem (normal) segue exigindo token.
    assert.equal(await requisicaoCrua(porta, 'GET /api/rotas HTTP/1.1'), 401);
    // /health continua público, inclusive em forma absoluta.
    assert.equal(await requisicaoCrua(porta, 'GET /health HTTP/1.1'), 200);
    assert.equal(await requisicaoCrua(porta, 'GET http://evil.example/health HTTP/1.1'), 200);
  } finally {
    await app.close();
  }
});
