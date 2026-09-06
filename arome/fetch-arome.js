// Descarga los GeoTIFF horarios de un parámetro AROME (última ejecución del
// modelo disponible) para un dominio fijo (cornisa cantábrica) y los guarda
// en data/frames_<parametro>/. Reintentable: si un fichero ya existe, se
// omite, así que puede relanzarse tras un corte de red sin perder lo hecho.

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

const PARAMETROS = {
  temperatura: { coverage: "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", altura: 2, bbox: BBOX_ESPANA },
  precipitacion: { coverage: "TOTAL_PRECIPITATION__GROUND_OR_WATER_SURFACE", sufijo: "_PT1H", bbox: BBOX_ESPANA },
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
  console.log(`${horas.length} horas a descargar`);

  const dirSalida = `data/frames_${nombreParam}`;
  await mkdir(dirSalida, { recursive: true });

  const metaPath = `${dirSalida}/_meta.json`;
  await writeFile(metaPath, JSON.stringify({ coverageId, ejecucion, inicio, fin, bbox: param.bbox, altura: param.altura }, null, 2));

  for (const hora of horas) {
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
