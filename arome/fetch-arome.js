// Descarga los GeoTIFF horarios de un parámetro AROME (última ejecución del
// modelo disponible) para un dominio fijo (cornisa cantábrica) y los guarda
// en data/frames_<parametro>/. Reintentable: si un fichero ya existe, se
// omite, así que puede relanzarse tras un corte de red sin perder lo hecho.
//
// Solo pide las horas que AÚN NO están renderizadas en data/png_<parametro>/
// (ver manifiesto.json ahí) — Météo-France publica las horas largas del
// pronóstico (+31h a +51h) bastante después que las cortas, así que el mismo
// run se completa en varias pasadas del workflow en vez de descartar lo ya
// conseguido y reintentar solo lo que falta cada vez (ver render-frames.js
// para la parte que conserva/poda frames entre pasadas).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  obtenerToken,
  obtenerUltimaEjecucion,
  describirCobertura,
  obtenerCoverageGeoTiff,
} from "./lib/meteofrance.js";

// España peninsular + Baleares, recortado al límite real del dominio AROME
// (lat mínima 37.5°N) — por eso se queda fuera la franja sur de Andalucía
// (Cádiz, Málaga, Almería, gran parte de Huelva/Sevilla/Granada) y Canarias,
// que no está ni remotamente en este dominio.
const BBOX_ESPANA = [-9.9, 37.5, 4.4, 43.9];
// Dominio anterior (cornisa cantábrica), se deja por si se necesita un recorte más fino.
const BBOX_CANTABRICO = [-9.3, 41.8, -1.6, 44.3];

// conEtiquetas: igual que en render-frames.js — si la hora ya está en el
// manifiesto pero SIN el array "etiquetas" (p.ej. porque se generó con una
// versión anterior de render-frames.js, antes de añadir esa rejilla), no
// cuenta como "ya renderizada": se vuelve a pedir. Bug real encontrado en
// producción (2026-09-17): sin esto, las horas ya presentes al desplegar la
// función de etiquetas se quedaban para siempre sin ellas — como la
// animación siempre empieza por las horas más próximas (las primeras en
// entrar al manifiesto, luego las primeras en "darse por hechas"), el
// usuario veía los números clavados en el primer valor real que sí llegó a
// cargar, en vez de ir cambiando con cada hora.
const PARAMETROS = {
  temperatura: { coverage: "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", altura: 2, bbox: BBOX_ESPANA, conEtiquetas: true },
  precipitacion: { coverage: "TOTAL_PRECIPITATION__GROUND_OR_WATER_SURFACE", sufijo: "_PT1H", bbox: BBOX_ESPANA },
  // Nubosidad total (%), instantánea (sin sufijo de acumulación) y sin
  // dimensión "height" (es GROUND_OR_WATER_SURFACE, no
  // SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND) — verificado en vivo, valores 0-100.
  nubosidad: { coverage: "TOTAL_CLOUD_COVER__GROUND_OR_WATER_SURFACE", bbox: BBOX_ESPANA },
};

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

async function horasYaRenderizadas(nombreParam, conEtiquetas) {
  const manifiestoPath = `data/png_${nombreParam}/manifiesto.json`;
  if (!existsSync(manifiestoPath)) return new Set();
  try {
    const manifiesto = JSON.parse(await readFile(manifiestoPath, "utf8"));
    const frames = manifiesto.frames || [];
    const completos = conEtiquetas ? frames.filter((f) => f.etiquetas) : frames;
    return new Set(completos.map((f) => f.hora));
  } catch {
    return new Set();
  }
}

async function main() {
  const nombreParam = process.argv[2] || "temperatura";
  const param = PARAMETROS[nombreParam];
  if (!param) {
    console.error(`Parámetro desconocido: ${nombreParam}. Disponibles: ${Object.keys(PARAMETROS).join(", ")}`);
    process.exit(1);
  }

  // En GitHub Actions la credencial llega como secreto de entorno; en local
  // se lee del fichero (que nunca se sube al repo, ver .gitignore).
  const basicAuth = process.env.METEOFRANCE_BASIC_AUTH
    || JSON.parse(await readFile("credenciales.json", "utf8")).basicAuth;
  let token = await obtenerToken(basicAuth);
  let tokenObtenidoEn = Date.now();

  const { coverageId, timestamp: ejecucion } = await obtenerUltimaEjecucion(token, param.coverage, param.sufijo || "");
  console.log(`Última ejecución de ${param.coverage}${param.sufijo || ""}: ${ejecucion} -> coverageId=${coverageId}`);

  const { inicio, fin } = await describirCobertura(token, coverageId);
  console.log(`Rango de pronóstico: ${inicio} .. ${fin}`);

  const horas = listaHorasEntre(inicio, fin);
  const yaRenderizadas = await horasYaRenderizadas(nombreParam, param.conEtiquetas);
  const horasPendientes = horas.filter((h) => !yaRenderizadas.has(h));
  console.log(`${horas.length} horas en el rango de pronóstico, ${yaRenderizadas.size} ya renderizadas de una pasada anterior, ${horasPendientes.length} pendientes de descargar`);

  const dirSalida = `data/frames_${nombreParam}`;
  await mkdir(dirSalida, { recursive: true });

  const metaPath = `${dirSalida}/_meta.json`;
  await writeFile(metaPath, JSON.stringify({ coverageId, ejecucion, inicio, fin, bbox: param.bbox, altura: param.altura }, null, 2));

  for (const hora of horasPendientes) {
    const destino = `${dirSalida}/${hora.replace(/:/g, "-")}.tiff`;
    if (existsSync(destino)) {
      console.log(`  [saltado] ${hora} (ya existe)`);
      continue;
    }
    // Renovar el token si lleva más de 50 min emitido (expira a los 60 min).
    if (Date.now() - tokenObtenidoEn > 50 * 60 * 1000) {
      token = await obtenerToken(basicAuth);
      tokenObtenidoEn = Date.now();
    }
    try {
      const tiff = await obtenerCoverageGeoTiff(token, {
        coverageId,
        bbox: param.bbox,
        altura: param.altura,
        tiempo: hora,
      });
      await writeFile(destino, tiff);
      console.log(`  [ok] ${hora} (${(tiff.length / 1024).toFixed(0)} KB)`);
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
