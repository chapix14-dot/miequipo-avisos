// Vigilante de la RFFM para la app Mi Equipo.
//
// Se ejecuta cada ~10 min en GitHub Actions (ver .github/workflows/vigilante.yml):
//   1. Lee de Firestore los equipos que siguen los móviles (colección `seguidos`).
//   2. Por cada grupo, pide el calendario a la RFFM (solo si toca: ver debeConsultar).
//   3. Compara con lo que vio la vez anterior (colección `estado`) y manda un push FCM al tema
//      del equipo (`eq_{grupo}_{equipo}`) por cada resultado nuevo / cambio de horario.
//
// Simulacro sin Firebase (comprueba que la RFFM se entiende y qué detectaría):
//   node vigilante.mjs --simulacro <grupoId> <competicionId> <temporada> <equipoId>

import { analizar, debeConsultar, leerCalendario } from './logica.mjs';

const RFFM = 'https://www.rffm.es';
const MAX_GRUPOS = 150;
const OLVIDAR_TRAS_DIAS = 90;
const PAUSA_ENTRE_GRUPOS_MS = 500;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedirCalendario({ grupoId, competicionId, temporada }) {
  const url = `${RFFM}/api/calendar?groupId=${grupoId}&competitionId=${competicionId}&seasonId=${temporada}`;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MiEquipoVigilante/1.0)', Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (!json || !Array.isArray(json.rounds)) throw new Error('respuesta sin "rounds"');
      return json;
    } catch (e) {
      if (intento === 3) throw e;
      await dormir(1500 * intento);
    }
  }
}

async function simulacro([grupoId, competicionId, temporada, equipoId]) {
  if (!equipoId) throw new Error('Uso: --simulacro <grupoId> <competicionId> <temporada> <equipoId>');
  const calendario = await pedirCalendario({ grupoId, competicionId, temporada });
  const partidos = leerCalendario(calendario);
  console.log(`Calendario leído: ${partidos.length} partidos.`);
  const mios = partidos.filter(({ rec }) => rec.l === equipoId || rec.v === equipoId);
  console.log(`Partidos del equipo ${equipoId}: ${mios.length}`);
  for (const { clave, rec } of mios.slice(0, 40)) {
    console.log(`  J${rec.j} ${rec.f} ${rec.h} ${rec.ln} ${rec.gl ?? '-'}-${rec.gv ?? '-'} ${rec.vn} [${clave}] ${rec.c}`);
  }
  // Primera pasada (sin estado previo): no debe avisar de nada.
  const seguidos = new Map([[equipoId, `equipo ${equipoId}`]]);
  const primera = analizar({ previo: null, partidos, seguidos, grupoId, ahora: Date.now() });
  console.log(`Primera pasada: ${primera.avisos.length} avisos (debe ser 0).`);
  // Segunda pasada simulando que el último partido jugado aún no tenía resultado.
  const jugados = Object.entries(primera.estado.partidos).filter(([, p]) => p.gl != null);
  if (jugados.length > 0) {
    const [clave, rec] = jugados[jugados.length - 1];
    const previo = structuredClone(primera.estado);
    previo.partidos[clave] = { ...rec, gl: null, gv: null };
    const segunda = analizar({ previo, partidos, seguidos, grupoId, ahora: Date.now() });
    console.log('Si ese resultado hubiera aparecido ahora, se avisaría así:');
    for (const a of segunda.avisos) console.log(`  [${a.tema}] ${a.titulo} — ${a.texto}`);
  }
}

async function main() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
  const { getMessaging } = await import('firebase-admin/messaging');

  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) throw new Error('Falta el secreto FIREBASE_SERVICE_ACCOUNT');
  initializeApp({ credential: cert(JSON.parse(credenciales)) });
  // Base con nombre dentro del proyecto linacentro-b2b (así no se tocan las reglas de la web B2B).
  const db = getFirestore('miequipo');
  const mensajeria = getMessaging();
  const ahora = Date.now();

  // Modo prueba (workflow_dispatch con "tema_prueba"): manda una notificación de mentira a ese
  // tema (eq_{grupo}_{equipo}) para comprobar que llega al móvil, y termina.
  if (process.env.TEMA_PRUEBA) {
    const tema = process.env.TEMA_PRUEBA.trim();
    if (!/^eq_[0-9]{1,12}_[0-9]{1,12}$/.test(tema)) throw new Error(`Tema de prueba no válido: ${tema}`);
    await mensajeria.send({
      topic: tema,
      notification: { title: '🔔 Prueba de avisos · Mi Equipo', body: 'Si lees esto, los avisos desde la nube funcionan.' },
      data: { tipo: 'prueba', clave: `prueba:${ahora}`, detalle: 'Aviso de prueba enviado desde el vigilante.' },
      android: { priority: 'high', ttlMillis: 3600 * 1000, notification: { channelId: 'resultados', tag: `prueba:${ahora}` } },
    });
    console.log(`Aviso de prueba enviado al tema ${tema}.`);
    return;
  }

  // 1) Equipos vigilados, agrupados por grupo; se olvidan los que llevan 90 días sin "visto".
  const instantanea = await db.collection('seguidos').get();
  const grupos = new Map();
  let olvidados = 0;
  for (const doc of instantanea.docs) {
    const d = doc.data();
    const visto = d.visto instanceof Timestamp ? d.visto.toMillis() : 0;
    if (ahora - visto > OLVIDAR_TRAS_DIAS * 86_400_000) {
      await doc.ref.delete();
      olvidados++;
      continue;
    }
    if (!d.grupoId || !d.competicionId || !d.equipoId || !d.temporada) continue;
    const clave = String(d.grupoId);
    if (!grupos.has(clave)) {
      grupos.set(clave, { grupoId: clave, competicionId: String(d.competicionId), temporada: Number(d.temporada), equipos: new Map() });
    }
    grupos.get(clave).equipos.set(String(d.equipoId), String(d.nombre || d.equipoId));
  }
  console.log(`Equipos vigilados: ${instantanea.size - olvidados} en ${grupos.size} grupos (olvidados por antiguos: ${olvidados}).`);

  let consultados = 0;
  let enviados = 0;
  let fallos = 0;

  for (const grupo of [...grupos.values()].slice(0, MAX_GRUPOS)) {
    const refEstado = db.collection('estado').doc(grupo.grupoId);
    const previo = (await refEstado.get()).data()?.json;
    const estadoPrevio = previo ? JSON.parse(previo) : null;

    // Si cambian los equipos vigilados hay que reconsultar para memorizarlos (sin avisar).
    const equiposNuevos = !estadoPrevio || [...grupo.equipos.keys()].some((id) => !estadoPrevio.equipos.includes(id));
    if (!equiposNuevos && !debeConsultar(estadoPrevio, ahora)) continue;

    let calendario;
    try {
      calendario = await pedirCalendario(grupo);
    } catch (e) {
      fallos++;
      console.warn(`Grupo ${grupo.grupoId}: la RFFM no responde (${e.message}); se reintenta en la próxima pasada.`);
      await dormir(PAUSA_ENTRE_GRUPOS_MS);
      continue;
    }
    consultados++;

    const { estado, avisos } = analizar({
      previo: estadoPrevio,
      partidos: leerCalendario(calendario),
      seguidos: grupo.equipos,
      grupoId: grupo.grupoId,
      ahora,
    });

    // 2) Push por cada aviso. Si uno falla, ese partido se queda como estaba para reintentarlo.
    for (const a of avisos) {
      try {
        await mensajeria.send({
          topic: a.tema,
          notification: { title: a.titulo, body: a.texto },
          data: { tipo: a.tipo, clave: a.clave, detalle: a.detalle, titulo: a.titulo, texto: a.texto },
          android: {
            priority: 'high',
            ttlMillis: 12 * 3600 * 1000,
            notification: { channelId: 'resultados', tag: a.clave },
          },
        });
        enviados++;
        console.log(`  → ${a.tema}: ${a.titulo} — ${a.texto}`);
      } catch (e) {
        fallos++;
        console.warn(`  ✗ ${a.tema}: ${e.message}`);
        if (estadoPrevio?.partidos?.[a.partido]) estado.partidos[a.partido] = estadoPrevio.partidos[a.partido];
        else delete estado.partidos[a.partido];
      }
    }

    await refEstado.set({ json: JSON.stringify(estado), consulta: ahora });
    await dormir(PAUSA_ENTRE_GRUPOS_MS);
  }

  console.log(`Hecho: ${consultados} calendarios consultados, ${enviados} avisos enviados, ${fallos} fallos.`);
  // Que el trabajo falle visiblemente si TODO ha ido mal (RFFM bloqueando la IP, credenciales...).
  if (fallos > 0 && consultados === 0 && enviados === 0) process.exitCode = 1;
}

const args = process.argv.slice(2);
(args[0] === '--simulacro' ? simulacro(args.slice(1)) : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
