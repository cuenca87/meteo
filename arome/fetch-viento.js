// Descarga los GeoTIFF horarios de viento (componentes U y V a 10m) de la
// última ejecución de AROME disponible, para el mismo dominio que
// precipitación/temperatura. A diferencia de fetch-arome.js (un solo
// parámetro por hora), aquí hacen falta DOS coberturas por hora — U y V son
// necesarias juntas para poder dibujar vectores/animación de flujo, no basta
// con la velocidad escalar.
//
// Mismo patrón que fetch-arome.js: solo pide las horas que aún no están
// renderizadas (ver data/viento/manifiesto.json), reintentable si un fichero
// ya existe.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  obtenerToken,
  obtenerUltimaEjecucion,
  describirCobertura,
  obtenerCoverageGeoTiff,
} from "./lib/meteofrance.js";

// Mismo dominio que fetch-arome.js (España peninsular + Baleares).
const BBOX_ESPANA = [-9.9, 37.5, 4.4, 43.9];
const ALTURA_M = 10; // viento a 10m (superficie) — alturas disponibles en AROME: 10, 20, 50, 100m

function listaHorasEntre(inicioISO, finISO) {
  const horas = [];
  let t = new Date(inicioISO);
  const fin = new Date(finISO);
  while (t <= fin) {
    horas.push(t.toISOString().replace(/\.\d{3}Z$/, "Z"));
    t = new Date(t.getTime() + 3600 * 1000);
  }
  return horas;
}

async function horasYaRenderizadas() {
  const manifiestoPath = "data/viento/manifiesto.json";
  if (!existsSync(manifiestoPath)) return new Set();
  try {
    const manifiesto = JSON.parse(await readFile(manifiestoPath, "utf8"));
    return new Set((manifiesto.frames || []).map((f) => f.hora));
  } catch {
    return new Set();
  }
}

async function main() {
  const basicAuth = process.env.METEOFRANCE_BASIC_AUTH
    || JSON.parse(await readFile("credenciales.json", "utf8")).basicAuth;
  let token = await obtenerToken(basicAuth);
  let tokenObtenidoEn = Date.now();

  const { coverageId: coverageIdU, timestamp: ejecucionU } = await obtenerUltimaEjecucion(token, "U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", "");
  const { coverageId: coverageIdV, timestamp: ejecucionV } = await obtenerUltimaEjecucion(token, "V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", "");
  console.log(`Última ejecución U: ${ejecucionU} -> ${coverageIdU}`);
  console.log(`Última ejecución V: ${ejecucionV} -> ${coverageIdV}`);
  if (ejecucionU !== ejecucionV) {
    console.warn(`AVISO: U y V no están en el mismo run (${ejecucionU} vs ${ejecucionV}) — se usa igualmente, ambas son campos primarios de AROME y deberían ir siempre sincronizadas.`);
  }

  const { inicio, fin } = await describirCobertura(token, coverageIdU);
  console.log(`Rango de pronóstico: ${inicio} .. ${fin}`);

  const horas = listaHorasEntre(inicio, fin);
  const yaRenderizadas = await horasYaRenderizadas();
  const horasPendientes = horas.filter((h) => !yaRenderizadas.has(h));
  console.log(`${horas.length} horas en el rango de pronóstico, ${yaRenderizadas.size} ya renderizadas de una pasada anterior, ${horasPendientes.length} pendientes de descargar`);

  const dirSalida = "data/frames_viento";
  await mkdir(dirSalida, { recursive: true });

  const metaPath = `${dirSalida}/_meta.json`;
  await writeFile(metaPath, JSON.stringify({ coverageIdU, coverageIdV, ejecucion: ejecucionU, inicio, fin, bbox: BBOX_ESPANA, altura: ALTURA_M }, null, 2));

  for (const hora of horasPendientes) {
    const destinoU = `${dirSalida}/${hora.replace(/:/g, "-")}_u.tiff`;
    const destinoV = `${dirSalida}/${hora.replace(/:/g, "-")}_v.tiff`;
    if (existsSync(destinoU) && existsSync(destinoV)) {
      console.log(`  [saltado] ${hora} (ya existe)`);
      continue;
    }
    // Renovar el token si lleva más de 50 min emitido (expira a los 60 min).
    if (Date.now() - tokenObtenidoEn > 50 * 60 * 1000) {
      token = await obtenerToken(basicAuth);
      tokenObtenidoEn = Date.now();
    }
    try {
      const [tiffU, tiffV] = await Promise.all([
        obtenerCoverageGeoTiff(token, { coverageId: coverageIdU, bbox: BBOX_ESPANA, altura: ALTURA_M, tiempo: hora }),
        obtenerCoverageGeoTiff(token, { coverageId: coverageIdV, bbox: BBOX_ESPANA, altura: ALTURA_M, tiempo: hora }),
      ]);
      await writeFile(destinoU, tiffU);
      await writeFile(destinoV, tiffV);
      console.log(`  [ok] ${hora} (U ${(tiffU.length / 1024).toFixed(0)} KB, V ${(tiffV.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`  [error] ${hora}: ${err.message}`);
    }
  }

  console.log(`\nListo. Frames en ${dirSalida}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
