import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motoristasParaRota } from './motoristas.js';

test('a rota só vai para MOTORISTA ativo — nem o Admin, nem o desativado', () => {
  const usuarios = [
    { id: 'a', nome: 'Logística VD Penedo', papel: 'admin' as const, ativo: true },
    { id: 'm', nome: 'Motorista Penedo', papel: 'motorista' as const, ativo: true },
    { id: 'x', nome: 'Motorista Antigo', papel: 'motorista' as const, ativo: false },
    { id: 'o', nome: 'Operador', papel: 'operador' as const, ativo: true },
  ];
  assert.deepEqual(motoristasParaRota(usuarios).map((u) => u.id), ['m']);
});
