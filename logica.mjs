// Lógica pura del vigilante (sin red ni Firebase): se puede probar con `npm test`.

const HORAS = 3600 * 1000;

/** Calendario de /api/calendar -> lista de {clave, rec} con registros compactos. */
export function leerCalendario(calendar) {
  const partidos = [];
  for (const ronda of calendar?.rounds ?? []) {
    const jornada = parseInt(ronda.codjornada, 10);
    if (Number.isNaN(jornada)) continue;
    for (const p of ronda.equipos ?? []) {
      const num = (v) => {
        const n = parseInt(v, 10);
        return Number.isNaN(n) ? null : n;
      };
      const rec = {
        j: jornada,
        f: String(p.fecha ?? ''),
        h: String(p.hora ?? ''),
        c: String(p.campo ?? ''),
        l: String(p.codigo_equipo_local ?? ''),
        v: String(p.codigo_equipo_visitante ?? ''),
        ln: String(p.equipo_local ?? ''),
        vn: String(p.equipo_visitante ?? ''),
        gl: num(p.goles_casa),
        gv: num(p.goles_visitante),
      };
      const clave = p.codacta ? String(p.codacta) : `${jornada}_${rec.l}_${rec.v}`;
      partidos.push({ clave, rec });
    }
  }
  return partidos;
}

/** Diferencia (ms) entre la hora de Madrid y UTC en ese instante. */
function desfaseMadrid(utcMs) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(partes.find((x) => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}

/** "dd-MM-yyyy" + "HH:mm" (hora de Madrid) -> instante en ms, o null si no se entiende. */
export function inicioPartido(fecha, hora) {
  const f = String(fecha).trim().split(/[-/]/).map(Number);
  if (f.length !== 3 || f.some(Number.isNaN)) return null;
  const h = String(hora).trim().split(':').map(Number);
  const hh = Number.isNaN(h[0]) ? 12 : h[0];
  const mm = Number.isNaN(h[1] ?? 0) ? 0 : (h[1] ?? 0);
  const ingenuo = Date.UTC(f[2], f[1] - 1, f[0], hh, mm);
  let t = ingenuo - desfaseMadrid(ingenuo);
  t = ingenuo - desfaseMadrid(t);
  return t;
}

/**
 * ¿Hay que pedir el calendario a la RFFM en esta pasada? Solo si no se conoce todavía, si hace
 * más de 6 h de la última consulta (horarios nuevos o cambiados, resultados tardíos) o si algún
 * partido seguido sin resultado está por empezar / acaba de jugarse.
 */
export function debeConsultar(previo, ahora) {
  if (!previo) return true;
  if (ahora - (previo.consulta ?? 0) > 6 * HORAS) return true;
  return Object.values(previo.partidos ?? {}).some((p) => {
    if (p.gl != null && p.gv != null) return false;
    const inicio = inicioPartido(p.f, p.h);
    return inicio != null && ahora >= inicio - 30 * 60 * 1000 && ahora <= inicio + 8 * HORAS;
  });
}

function tituloResultado(rec, esLocal, nombre) {
  const propios = esLocal ? rec.gl : rec.gv;
  const rival = esLocal ? rec.gv : rec.gl;
  if (propios > rival) return `✅ Victoria · ${nombre}`;
  if (propios === rival) return `🤝 Empate · ${nombre}`;
  return `❌ Derrota · ${nombre}`;
}

/**
 * Compara el calendario nuevo con el guardado y saca los avisos a mandar.
 *
 *  - previo: {equipos: [ids], partidos: {clave: rec}, consulta} o null (primera vez).
 *  - partidos: salida de leerCalendario().
 *  - seguidos: Map equipoId -> nombre (los equipos vigilados de este grupo).
 *
 * Un equipo que no estaba en `previo.equipos` solo se "memoriza" (no se avisa de lo que ya
 * había pasado antes de empezar a vigilarlo).
 */
export function analizar({ previo, partidos, seguidos, grupoId, ahora }) {
  const partidosNuevos = {};
  const avisos = [];
  const conocidos = new Set(previo?.equipos ?? []);

  for (const { clave, rec } of partidos) {
    const equiposSeguidos = [rec.l, rec.v].filter((id) => seguidos.has(id));
    if (equiposSeguidos.length === 0) continue;
    partidosNuevos[clave] = rec;
    const antes = previo?.partidos?.[clave];
    if (!antes) continue;

    for (const id of equiposSeguidos) {
      if (!conocidos.has(id)) continue;
      const nombre = seguidos.get(id);
      const esLocal = rec.l === id;
      const tema = `eq_${grupoId}_${id}`;
      const marcador = `${rec.ln} ${rec.gl} - ${rec.gv} ${rec.vn}`;
      const hayResultado = rec.gl != null && rec.gv != null;
      const habiaResultado = antes.gl != null && antes.gv != null;

      if (hayResultado && !habiaResultado) {
        avisos.push({
          clave: `${clave}:${id}:resultado`,
          partido: clave,
          tema,
          tipo: 'resultado',
          titulo: tituloResultado(rec, esLocal, nombre),
          texto: marcador,
          detalle: `${marcador}\nJornada ${rec.j}`,
        });
      } else if (hayResultado && habiaResultado && (antes.gl !== rec.gl || antes.gv !== rec.gv)) {
        avisos.push({
          clave: `${clave}:${id}:${rec.gl}-${rec.gv}`,
          partido: clave,
          tema,
          tipo: 'correccion',
          titulo: `✏️ Resultado corregido · ${nombre}`,
          texto: marcador,
          detalle: `${marcador}\nAntes: ${antes.gl} - ${antes.gv}\nJornada ${rec.j}`,
        });
      } else if (!hayResultado && (antes.f !== rec.f || antes.h !== rec.h || antes.c !== rec.c)) {
        const inicio = inicioPartido(rec.f, rec.h);
        if (inicio != null && inicio < ahora) continue; // ya pasó: no tiene sentido avisar
        const cambios = [];
        if (antes.f !== rec.f || antes.h !== rec.h) cambios.push(`ahora ${rec.f} ${rec.h} (antes ${antes.f} ${antes.h})`);
        if (antes.c !== rec.c) cambios.push(`campo: ${rec.c || 'sin asignar'}`);
        avisos.push({
          clave: `${clave}:${id}:${rec.f}${rec.h}${rec.c}`,
          partido: clave,
          tema,
          tipo: 'horario',
          titulo: `📅 Cambio de partido · ${nombre}`,
          texto: `${rec.ln} - ${rec.vn}: ${cambios.join(' · ')}`,
          detalle: `${rec.ln} - ${rec.vn}\nJornada ${rec.j}\n${cambios.join('\n')}`,
        });
      }
    }
  }

  const estado = { equipos: [...seguidos.keys()], partidos: partidosNuevos, consulta: ahora };
  return { estado, avisos };
}
