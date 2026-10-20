import test from 'node:test';
import assert from 'node:assert/strict';
import { analizar, debeConsultar, inicioPartido, leerCalendario } from '../logica.mjs';

const partido = (extra = {}) => ({
  j: 5, f: '15-11-2026', h: '10:30', c: 'Campo A',
  l: '100', v: '200', ln: 'LOCAL CF', vn: 'VISIT CF', gl: null, gv: null, ...extra,
});
const seguidos = new Map([['100', 'Local CF']]);
const base = { grupoId: '7', ahora: Date.UTC(2026, 10, 15, 14, 0) };

test('inicioPartido respeta el horario de Madrid (invierno CET y verano CEST)', () => {
  assert.equal(inicioPartido('15-11-2026', '10:30'), Date.UTC(2026, 10, 15, 9, 30));
  assert.equal(inicioPartido('15-09-2026', '10:30'), Date.UTC(2026, 8, 15, 8, 30));
  assert.equal(inicioPartido('mal', '10:30'), null);
});

test('primera vez: se memoriza todo y no se avisa de nada', () => {
  const r = analizar({ ...base, previo: null, seguidos, partidos: [{ clave: 'A1', rec: partido({ gl: 2, gv: 1 }) }] });
  assert.equal(r.avisos.length, 0);
  assert.deepEqual(r.estado.equipos, ['100']);
  assert.equal(r.estado.partidos.A1.gl, 2);
});

test('aparece el resultado: un aviso de victoria al tema del equipo', () => {
  const previo = { equipos: ['100'], partidos: { A1: partido() }, consulta: 0 };
  const r = analizar({ ...base, previo, seguidos, partidos: [{ clave: 'A1', rec: partido({ gl: 3, gv: 1 }) }] });
  assert.equal(r.avisos.length, 1);
  assert.equal(r.avisos[0].tema, 'eq_7_100');
  assert.equal(r.avisos[0].titulo, '✅ Victoria · Local CF');
  assert.equal(r.avisos[0].texto, 'LOCAL CF 3 - 1 VISIT CF');
});

test('empate y derrota según el lado del equipo seguido', () => {
  const previo = { equipos: ['200'], partidos: { A1: partido() }, consulta: 0 };
  const sig = new Map([['200', 'Visit CF']]);
  const d = analizar({ ...base, previo, seguidos: sig, partidos: [{ clave: 'A1', rec: partido({ gl: 3, gv: 1 }) }] });
  assert.equal(d.avisos[0].titulo, '❌ Derrota · Visit CF');
  const e = analizar({ ...base, previo, seguidos: sig, partidos: [{ clave: 'A1', rec: partido({ gl: 2, gv: 2 }) }] });
  assert.equal(e.avisos[0].titulo, '🤝 Empate · Visit CF');
});

test('sin cambios no se avisa dos veces', () => {
  const rec = partido({ gl: 3, gv: 1 });
  const previo = { equipos: ['100'], partidos: { A1: rec }, consulta: 0 };
  assert.equal(analizar({ ...base, previo, seguidos, partidos: [{ clave: 'A1', rec }] }).avisos.length, 0);
});

test('un equipo recién vigilado no recibe avisos de lo que ya estaba', () => {
  const previo = { equipos: ['999'], partidos: {}, consulta: 0 };
  const r = analizar({ ...base, previo, seguidos, partidos: [{ clave: 'A1', rec: partido({ gl: 3, gv: 1 }) }] });
  assert.equal(r.avisos.length, 0);
  assert.ok(r.estado.partidos.A1);
});

test('cambio de hora o de campo antes del partido', () => {
  const previo = { equipos: ['100'], partidos: { A1: partido({ f: '22-11-2026' }) }, consulta: 0 };
  const r = analizar({ ...base, previo, seguidos, partidos: [{ clave: 'A1', rec: partido({ f: '22-11-2026', h: '12:00' }) }] });
  assert.equal(r.avisos.length, 1);
  assert.equal(r.avisos[0].tipo, 'horario');
  assert.match(r.avisos[0].texto, /12:00/);
});

test('un resultado corregido avisa', () => {
  const previo = { equipos: ['100'], partidos: { A1: partido({ gl: 1, gv: 0 }) }, consulta: 0 };
  const r = analizar({ ...base, previo, seguidos, partidos: [{ clave: 'A1', rec: partido({ gl: 1, gv: 1 }) }] });
  assert.equal(r.avisos[0].tipo, 'correccion');
});

test('dos equipos seguidos en el mismo partido: un aviso a cada tema', () => {
  const dos = new Map([['100', 'Local CF'], ['200', 'Visit CF']]);
  const previo = { equipos: ['100', '200'], partidos: { A1: partido() }, consulta: 0 };
  const r = analizar({ ...base, previo, seguidos: dos, partidos: [{ clave: 'A1', rec: partido({ gl: 1, gv: 0 }) }] });
  assert.deepEqual(r.avisos.map((a) => a.tema).sort(), ['eq_7_100', 'eq_7_200']);
});

test('debeConsultar: sin datos, caducado o partido en curso; si no, no', () => {
  const ahora = Date.UTC(2026, 10, 15, 10, 0); // 11:00 en Madrid
  assert.equal(debeConsultar(null, ahora), true);
  const futuro = { consulta: ahora - 60_000, partidos: { A1: partido({ f: '20-11-2026' }) } };
  assert.equal(debeConsultar(futuro, ahora), false);
  assert.equal(debeConsultar({ ...futuro, consulta: ahora - 7 * 3600_000 }, ahora), true);
  const enCurso = { consulta: ahora - 60_000, partidos: { A1: partido({ f: '15-11-2026', h: '10:30' }) } };
  assert.equal(debeConsultar(enCurso, ahora), true);
  const jugado = { consulta: ahora - 60_000, partidos: { A1: partido({ f: '15-11-2026', h: '10:30', gl: 1, gv: 1 }) } };
  assert.equal(debeConsultar(jugado, ahora), false);
});

test('leerCalendario entiende el formato de la RFFM', () => {
  const lista = leerCalendario({
    rounds: [{
      codjornada: '3',
      equipos: [{
        fecha: '15-11-2026', hora: '10:30', campo: 'X', equipo_local: 'A', equipo_visitante: 'B',
        codigo_equipo_local: '1', codigo_equipo_visitante: '2', goles_casa: '', goles_visitante: '', codacta: '555',
      }],
    }],
  });
  assert.equal(lista.length, 1);
  assert.equal(lista[0].clave, '555');
  assert.equal(lista[0].rec.gl, null);
  assert.equal(lista[0].rec.j, 3);
});
