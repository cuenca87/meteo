// Convierte cada par de GeoTIFF horarios (U, V) en un JSON de campo vectorial
// en el formato que espera el plugin leaflet-velocity (mismo formato que usan
// los conversores grib2json de GFS: un array de dos "records", uno por
// componente, con header de rejilla + array de valores). A diferencia de
// render-frames.js (que pinta un PNG), aquí no hay imagen: el navegador
// recibe los valores U/V en m/s tal cual y el plugin dibuja/anima las
// partículas en un <canvas> propio.
//
// Mismo patrón de conservar/podar entre pasadas que render-frames.js: los
// frames de una pasada anterior que aún no han pasado se conservan, se
// añaden los nuevos, se poda lo que ya quedó en el pasado.

import { readdir, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";

// Factor de diezmado sobre la rejilla nativa (0.01°, ~1.1km) — mucho más
// bastro que el de precipitación/temperatura (DIEZMADO=2, ~2.2km) porque un
// campo de vectores no necesita ni de lejos esa densidad para verse bien
// animado a escala país, y cada punto de más cuenta doble (U+V).
const DIEZMADO_VIENTO = 12; // ~0.12° (~13km) de separación entre vectores

async function tiffARaster(rutaTiff) {
  const buf = await readFile(rutaTiff);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const image = await tiff.getImage();
  const raster = (await image.readRasters())[0];
  return { raster, width: image.getWidth(), height: image.getHeight(), bbox: image.getBoundingBox() };
}

// Diezma con nearest-neighbor (igual criterio que render-frames.js) y
// sustituye nodata/valores no finitos por 0 (sin viento) — el dominio AROME
// cubre de sobra el bbox de España, en la práctica no debería haber huecos.
function diezmar(raster, widthOrig, heightOrig) {
  const width = Math.ceil(widthOrig / DIEZMADO_VIENTO);
  const height = Math.ceil(heightOrig / DIEZMADO_VIENTO);
  const datos = new Array(width * height);
  for (let y = 0; y < height; y++) {
    const ySrc = Math.min(y * DIEZMADO_VIENTO, heightOrig - 1);
    for (let x = 0; x < width; x++) {
      const xSrc = Math.min(x * DIEZMADO_VIENTO, widthOrig - 1);
      const v = raster[ySrc * widthOrig + xSrc];
      datos[y * width + x] = (v === 9999 || !Number.isFinite(v)) ? 0 : v;
    }
  }
  return { datos, width, height };
}

async function tiffsAVectorField(rutaU, rutaV, horaISO) {
  const [u, v] = await Promise.all([tiffARaster(rutaU), tiffARaster(rutaV)]);
  const { datos: datosU, width, height } = diezmar(u.raster, u.width, u.height);
  const { datos: datosV } = diezmar(v.raster, v.width, v.height);

  const [lonMin, latMin, lonMax, latMax] = u.bbox; // [xmin, ymin, xmax, ymax]
  const headerBase = {
    la1: latMax, lo1: lonMin, la2: latMin, lo2: lonMax,
    nx: width, ny: height,
    dx: (lonMax - lonMin) / (width - 1),
    dy: (latMax - latMin) / (height - 1),
    refTime: horaISO,
    forecastTime: 0,
    gridDefinitionTemplate: 0,
  };

  let velMax = 0;
  for (let i = 0; i < datosU.length; i++) {
    const vel = Math.sqrt(datosU[i] * datosU[i] + datosV[i] * datosV[i]);
    if (vel > velMax) velMax = vel;
  }

  const campo = [
    { header: { ...headerBase, parameterCategory: 2, parameterNumber: 2 }, data: datosU },
    { header: { ...headerBase, parameterCategory: 2, parameterNumber: 3 }, data: datosV },
  ];
  return { campo, bbox: u.bbox, velMax };
}

async function main() {
  const dirEntrada = "data/frames_viento";
  const dirSalida = "data/viento";
  await mkdir(dirSalida, { recursive: true });

  const meta = JSON.parse(await readFile(`${dirEntrada}/_meta.json`, "utf8"));
  const ficheros = (await readdir(dirEntrada)).filter((f) => f.endsWith("_u.tiff")).sort();

  // Igual que render-frames.js: conservar frames previos que aún no han
  // pasado, podar (y borrar del disco) los que ya quedaron atrás.
  const manifiestoPath = `${dirSalida}/manifiesto.json`;
  let framesPrevios = [];
  let bboxPrevio = null;
  if (existsSync(manifiestoPath)) {
    const previo = JSON.parse(await readFile(manifiestoPath, "utf8"));
    bboxPrevio = previo.bbox ?? null;
    const ahora = Date.now();
    for (const f of previo.frames || []) {
      if (new Date(f.hora).getTime() >= ahora) {
        framesPrevios.push(f);
      } else {
        await unlink(`${dirSalida}/${f.archivo}`).catch(() => {});
      }
    }
  }

  const frames = [...framesPrevios];
  let bboxGlobal = bboxPrevio;
  for (const ficheroU of ficheros) {
    const horaISO = ficheroU.replace(/_u\.tiff$/, "").replace(/(\d{2})-(\d{2})-(\d{2})Z$/, "$1:$2:$3Z");
    const ficheroV = ficheroU.replace(/_u\.tiff$/, "_v.tiff");
    if (!existsSync(`${dirEntrada}/${ficheroV}`)) {
      console.warn(`  [saltado] ${horaISO}: falta el componente V`);
      continue;
    }
    const { campo, bbox, velMax } = await tiffsAVectorField(`${dirEntrada}/${ficheroU}`, `${dirEntrada}/${ficheroV}`, horaISO);
    bboxGlobal = bbox;
    const nombreJson = `${horaISO.replace(/:/g, "-")}.json`;
    await writeFile(`${dirSalida}/${nombreJson}`, JSON.stringify(campo));
    frames.push({ hora: horaISO, archivo: nombreJson, velMax: Number(velMax.toFixed(1)) });
    console.log(`  [ok] ${horaISO} -> ${nombreJson} (vel. máx ${velMax.toFixed(1)} m/s)`);
  }

  const porHora = new Map();
  for (const f of frames) porHora.set(f.hora, f);
  const framesFinal = [...porHora.values()].sort((a, b) => a.hora.localeCompare(b.hora));

  await writeFile(manifiestoPath, JSON.stringify({
    parametro: "viento",
    unidad: "m/s",
    ejecucion: meta.ejecucion,
    bbox: bboxGlobal,
    frames: framesFinal,
  }, null, 2));

  console.log(`\n${ficheros.length} frames nuevos + ${framesPrevios.length} conservados de antes = ${framesFinal.length} frames totales en ${dirSalida}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
