# Servidor de avisos de Mi Equipo

Es el equivalente a lo que hace MatchApp: **un servidor en la nube vigila la RFFM y manda la
notificación al móvil por push (Firebase Cloud Messaging)**. El móvil ya no tiene que
"despertarse" para mirar nada, así que llega con la app cerrada. **No depende de tu PC.**

```
 App (móvil)                        Nube (gratis)                              RFFM
 ───────────                        ─────────────                              ────
 sigues un equipo ──REST──► Firestore  seguidos/{grupo}_{equipo}
 + se suscribe al tema FCM            ▲
   eq_{grupo}_{equipo}                │ lee cada ~10 min
                                      │
                        GitHub Actions (vigilante.mjs) ──► /api/calendar ──► ¿resultado nuevo?
                                      │                                      ¿cambio de horario?
 notificación ◄────── FCM (tema) ◄────┘  manda un push al tema
```

* `vigilante.mjs` – el vigilante (Node 22). Cada pasada: lee `seguidos`, pide el calendario de
  cada grupo **solo si toca** (hay un partido en curso o hace >6 h de la última vez), lo compara
  con lo que vio antes (`estado/{grupo}`) y manda los avisos. Detecta: **resultado nuevo**,
  **resultado corregido** y **cambio de fecha/hora/campo**. Un equipo recién añadido no recibe
  avisos de lo que ya había pasado.
* `logica.mjs` + `test/` – la lógica pura, con pruebas (`npm test`).
* `firestore.rules` – reglas (de la base `miequipo`): la app solo puede crear/actualizar su documento de `seguidos`
  con campos validados; nadie puede leer ni borrar desde fuera.
* `.github/workflows/vigilante.yml` – lo ejecuta GitHub cada 10 min.
* Los equipos que llevan **90 días sin abrir la app** se olvidan solos.

## Puesta en marcha (una sola vez, ~15 min, sin tarjeta)

### 1. Firebase (ya hecho el 2026-10-20 en el proyecto `linacentro-b2b`, cuenta Linacentro)

* Se reutiliza el proyecto `linacentro-b2b` (plan Blaze). **No se tocó su base `(default)` ni sus
  reglas** (son las de la web B2B): se creó una **segunda base de Firestore llamada `miequipo`**
  (eur3, modo producción) con las reglas de [`firestore.rules`](firestore.rules).
* Se registró la app Android `com.chapix.miequipo` y su `google-services.json` está en
  `MiEquipoAppappgoogle-services.json` (en `.gitignore`).
* Pendiente: **Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada**
  (un `.json`): es el secreto del vigilante, solo va al paso 7.

### 2. Repositorio en GitHub (hecho: chapix14-dot/miequipo-avisos) (público, para que los minutos de Actions sean ilimitados)

6. Crea un repositorio **público** (p. ej. `miequipo-avisos`) y sube **el contenido de esta carpeta
   `servidor`** como raíz del repo (incluida `.github/`; `node_modules` ya está ignorado):

   ```bash
   cd servidor
   git init -b main
   git add .
   git commit -m "Vigilante de Mi Equipo"
   git remote add origin https://github.com/TU_USUARIO/miequipo-avisos.git
   git push -u origin main
   ```

   No hay nada secreto en el código; las claves van como *secret*.
7. En el repo: **Settings → Secrets and variables → Actions → New repository secret** →
   nombre `FIREBASE_SERVICE_ACCOUNT`, valor = **todo el contenido** del `.json` del paso 5.
8. Pestaña **Actions** → *Vigilante RFFM* → **Run workflow** para probarlo. Debe terminar en
   verde y decir `Equipos vigilados: 0 en 0 grupos` (aún no hay móviles registrados).

### 3. Compilar e instalar la app

```bash
crear_apk.bat
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Abre la app con un equipo en "Mis equipos" y acepta el permiso de notificaciones. En
**Mis equipos → Avisos de resultados** debe salir **"✓ Avisos desde la nube activos"**. Si sale un
error, ahí queda el motivo (ver más abajo). Al cabo de ≤10 min, en la pestaña Actions el log del
vigilante dirá `Equipos vigilados: 1 en 1 grupos`.

## Probar sin esperar a un partido

* Simulacro contra la RFFM real (no necesita Firebase):

  ```bash
  cd servidor
  npm install
  node vigilante.mjs --simulacro <grupoId> <competicionId> <temporada> <equipoId>
  ```
  Muestra los partidos del equipo y el aviso que mandaría si apareciese un resultado.
* Push de prueba a mano: consola de Firebase → **Messaging → Nueva campaña → Mensajes de
  Firebase Notification → Enviar mensaje de prueba**, o campaña con *Tema* = `eq_{grupo}_{equipo}`.

## Si algo no llega

| Síntoma | Causa probable |
|---|---|
| La tarjeta de la app dice `IOException: Firestore respondió 403` | La clave de API de Firebase está limitada: Google Cloud → APIs y servicios → Credenciales → *Android key* → quita la restricción de aplicación, o añade la huella SHA-1 de depuración (`gradlew signingReport`) a la app en Firebase. Compruébalo también que la API *Cloud Firestore* está permitida en la clave. |
| `Firestore respondió 404`/`PERMISSION_DENIED` | No se creó la base de datos o no se publicaron las reglas (pasos 2-3). |
| Registrado ✓ pero no llega nada con la app cerrada | Xiaomi/MIUI: Ajustes → Apps → Mi Equipo → **Inicio automático** y batería **Sin restricciones** (botón en la propia tarjeta). |
| El workflow falla en rojo | Mira el log: secreto mal pegado, o la RFFM bloquea las IP de GitHub (entonces habría que mover el vigilante a otro sitio; hasta hoy la RFFM responde sin cabeceras especiales). |
| Los avisos tardan 5-15 min | GitHub no garantiza el minuto exacto de un `cron`. Es el precio de lo gratuito. |

## Límites y costes

* **Coste: 0 €.** Firestore (Spark): unas pocas lecturas/escrituras por pasada; FCM: gratis.
  GitHub Actions: ilimitado en repos públicos.
* **Retraso**: la RFFM publica el resultado cuando el árbitro cierra el acta, y el vigilante lo
  ve en ≤10-15 min. No hay marcador en directo (la RFFM no lo expone).
* Si algún día quieres puntualidad de 1 min: mover `vigilante.mjs` a una *Cloud Function
  programada* (plan Blaze, coste prácticamente nulo) — la lógica de `logica.mjs` se reutiliza igual.
* Cada temporada nueva sigue valiendo lo de siempre: volver a añadir el equipo (códigos de grupo nuevos).

## Aviso de prueba a un móvil

GitHub → Actions → *Vigilante RFFM* → **Run workflow** → en "tema_prueba" escribe `eq_{grupo}_{equipo}`
(p. ej. `eq_26737762_4945054`). Manda una notificación de prueba a los móviles que sigan ese equipo.
