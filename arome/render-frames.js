// Convierte cada GeoTIFF horario en un PNG coloreado (rampa meteorológica de
// temperatura) + genera un manifiesto JSON con metadatos de cada frame para
// que el visor HTML los pueda animar sin decodificar GeoTIFF en el navegador.

import { readdir, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";
import { PNG } from "pngjs";

// Rampa de temperatura (°C) tipo meteorológico: violeta/azul (frío) -> verde
// -> amarillo -> naranja -> rojo/magenta (calor). Paradas y colores fijos,
// interpolación lineal en RGB entre paradas contiguas. Opaca en todo el
// rango (a:255) — a diferencia de precipitación/nubosidad, aquí no hay un
// "valor cero = nada que pintar": todo punto del mapa tiene una temperatura.
const PARADAS_TEMP = [
  { t: -10, color: [97, 33, 168], a: 255 },
  { t: 0, color: [66, 98, 214], a: 255 },
  { t: 5, color: [56, 164, 214], a: 255 },
  { t: 10, color: [77, 201, 168], a: 255 },
  { t: 15, color: [130, 211, 90], a: 255 },
  { t: 20, color: [222, 219, 66], a: 255 },
  { t: 25, color: [237, 164, 56], a: 255 },
  { t: 30, color: [227, 96, 46], a: 255 },
  { t: 35, color: [186, 39, 60], a: 255 },
  { t: 40, color: [140, 20, 90], a: 255 },
];

// Precipitación acumulada en 1h (mm = kg/m²), estilo radar: transparente en
// seco, ganando opacidad y virando azul -> verde -> amarillo -> naranja ->
// rojo/magenta según arrecia. Cada parada lleva su propio alfa (a, 0-255).
const PARADAS_PRECIP = [
  { t: 0, color: [70, 140, 255], a: 0 },
  { t: 0.2, color: [90, 160, 255], a: 70 },
  { t: 1, color: [60, 170, 235], a: 140 },
  { t: 4, color: [70, 200, 140], a: 190 },
  { t: 10, color: [235, 220, 60], a: 215 },
  { t: 20, color: [240, 140, 40], a: 230 },
  { t: 40, color: [220, 50, 50], a: 245 },
  { t: 80, color: [170, 30, 140], a: 255 },
];

// Nubosidad total (%): blanco translúcido creciendo en opacidad, estilo capa
// de nubes de satélite — 0% invisible (cielo despejado), 100% casi opaco pero
// sin llegar a 255 para que el mapa de fondo se intuya incluso con cielo cubierto.
const PARADAS_NUBOSIDAD = [
  { t: 0, color: [255, 255, 255], a: 0 },
  { t: 20, color: [240, 244, 248], a: 35 },
  { t: 50, color: [222, 228, 235], a: 110 },
  { t: 80, color: [205, 212, 222], a: 175 },
  { t: 100, color: [188, 196, 208], a: 225 },
];

// conEtiquetas: además de la imagen coloreada, guarda una rejilla de valores
// numéricos muestreados (para mostrar el número encima del mapa, a petición
// del usuario) — solo tiene sentido para temperatura por ahora (un número
// suelto de precipitación/nubosidad en un punto es mucho menos legible/útil
// que el propio color, y encarecería el manifiesto de los otros dos sin que
// se haya pedido).
const RAMPAS = {
  temperatura: { paradas: PARADAS_TEMP, unidad: "°C", conEtiquetas: true },
  precipitacion: { paradas: PARADAS_PRECIP, unidad: "mm/h" },
  nubosidad: { paradas: PARADAS_NUBOSIDAD, unidad: "%" },
};

// Interpolación lineal (color + alfa) entre las dos paradas contiguas al
// valor. Alfa por defecto 255 (opaco) si una parada no lo especifica — sin
// esto, "a" sale `undefined`, la interpolación da NaN, y PNG.data (Uint8Array)
// convierte NaN en 0 en silencio: el frame se genera sin error pero
// totalmente transparente. Bug real encontrado así con la rampa de
// temperatura (nunca llevó "a" en sus paradas) antes de tener este resguardo.
function colorEnRampa(v, paradas) {
  if (v <= paradas[0].t) return [...paradas[0].color, paradas[0].a ?? 255];
  const ultima = paradas[paradas.length - 1];
  if (v >= ultima.t) return [...ultima.color, ultima.a ?? 255];
  for (let i = 0; i < paradas.length - 1; i++) {
    const a = paradas[i];
    const b = paradas[i + 1];
    if (v >= a.t && v <= b.t) {
      const f = (v - a.t) / (b.t - a.t);
      const alfaA = a.a ?? 255, alfaB = b.a ?? 255;
      return [
        Math.round(a.color[0] + (b.color[0] - a.color[0]) * f),
        Math.round(a.color[1] + (b.color[1] - a.color[1]) * f),
        Math.round(a.color[2] + (b.color[2] - a.color[2]) * f),
        Math.round(alfaA + (alfaB - alfaA) * f),
      ];
    }
  }
  return [...ultima.color, ultima.a ?? 255];
}

// Factor de diezmado (nearest-neighbor): la resolución nativa (0.01°, ~1.1 km)
// es mucho más fina de lo necesario para un mapa animado a escala regional, y
// al automatizarse vía GitHub Actions (cada 3h) conviene mantener el peso de
// cada tanda de frames moderado.
const DIEZMADO = 2;

// Rejilla de etiquetas numéricas: se muestrea sobre el raster ORIGINAL (sin
// el diezmado de arriba, que es solo para la imagen), cada PASO_ETIQUETAS_PX
// píxeles nativos (~0.01°/px) — con 30px de paso salen ~0.3°/~33km entre
// puntos. El cliente decide cuántos de estos puntos pintar según el zoom
// (más densidad al acercar), así que aquí conviene generar de sobra: es
// mucho más barato guardar puntos de más en el JSON que tener que reprocesar
// el GeoTIFF si luego hiciera falta más densidad.
const PASO_ETIQUETAS_PX = 30;

function extraerRejillaEtiquetas(raster, widthOrig, heightOrig, pasoPx) {
  const cols = Math.floor((widthOrig - 1) / pasoPx) + 1;
  const filas = Math.floor((heightOrig - 1) / pasoPx) + 1;
  const valores = new Array(cols * filas);
  for (let fy = 0; fy < filas; fy++) {
    const ySrc = Math.min(fy * pasoPx, heightOrig - 1);
    for (let fx = 0; fx < cols; fx++) {
      const xSrc = Math.min(fx * pasoPx, widthOrig - 1);
      const v = raster[ySrc * widthOrig + xSrc];
      valores[fy * cols + fx] = (v === 9999 || !Number.isFinite(v)) ? null : Math.round(v);
    }
  }
  return { cols, filas, valores };
}

async function tiffAPng(rutaTiff, paradas, conEtiquetas) {
  const buf = await readFile(rutaTiff);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const image = await tiff.getImage();
  const raster = (await image.readRasters())[0];
  const widthOrig = image.getWidth();
  const heightOrig = image.getHeight();
  const bbox = image.getBoundingBox(); // [xmin, ymin, xmax, ymax]

  const width = Math.ceil(widthOrig / DIEZMADO);
  const height = Math.ceil(heightOrig / DIEZMADO);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raster.length; i++) {
    const v = raster[i];
    if (v === 9999 || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const ySrc = Math.min(y * DIEZMADO, heightOrig - 1);
    for (let x = 0; x < width; x++) {
      const xSrc = Math.min(x * DIEZMADO, widthOrig - 1);
      const v = raster[ySrc * widthOrig + xSrc];
      const idx = (y * width + x) * 4;
      if (v === 9999 || !Number.isFinite(v)) {
        png.data[idx + 3] = 0;
        continue;
      }
      const [r, g, b, a] = colorEnRampa(v, paradas);
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }

  const rejilla = conEtiquetas ? extraerRejillaEtiquetas(raster, widthOrig, heightOrig, PASO_ETIQUETAS_PX) : null;

  return { png, width, height, bbox, min, max, rejilla };
}

async function main() {
  const nombreParam = process.argv[2] || "temperatura";
  const rampa = RAMPAS[nombreParam];
  if (!rampa) {
    console.error(`Parámetro desconocido: ${nombreParam}. Disponibles: ${Object.keys(RAMPAS).join(", ")}`);
    process.exit(1);
  }
  const dirEntrada = `data/frames_${nombreParam}`;
  const dirSalida = `data/png_${nombreParam}`;
  await mkdir(dirSalida, { recursive: true });

  const meta = JSON.parse(await readFile(`${dirEntrada}/_meta.json`, "utf8"));
  const ficheros = (await readdir(dirEntrada)).filter((f) => f.endsWith(".tiff")).sort();

  // Frames ya publicados en una pasada anterior del workflow (mismo run u
  // otro más reciente): se conservan los que aún no han pasado, se sueltan
  // los que ya quedaron atrás en el tiempo (la animación siempre mira hacia
  // delante, no acumula histórico), y sus PNG huérfanos se borran del disco
  // para que no se cuelen en el commit.
  const manifiestoPath = `${dirSalida}/manifiesto.json`;
  let framesPrevios = [];
  let bboxPrevio = null;
  let rejillaPrevia = null;
  if (existsSync(manifiestoPath)) {
    const previo = JSON.parse(await readFile(manifiestoPath, "utf8"));
    bboxPrevio = previo.bbox ?? null;
    rejillaPrevia = previo.rejillaEtiquetas ?? null;
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
  let rejillaGlobal = rejillaPrevia;
  for (const fichero of ficheros) {
    const horaISO = fichero.replace(/\.tiff$/, "").replace(/(\d{2})-(\d{2})-(\d{2})Z$/, "$1:$2:$3Z");
    const { png, width, height, bbox, min, max, rejilla } = await tiffAPng(`${dirEntrada}/${fichero}`, rampa.paradas, rampa.conEtiquetas);
    bboxGlobal = bbox;
    const nombrePng = fichero.replace(/\.tiff$/, ".png");
    const bufferPng = PNG.sync.write(png);
    await writeFile(`${dirSalida}/${nombrePng}`, bufferPng);
    const frame = { hora: horaISO, archivo: nombrePng, min: Number(min.toFixed(1)), max: Number(max.toFixed(1)) };
    if (rejilla) {
      rejillaGlobal = { cols: rejilla.cols, filas: rejilla.filas };
      frame.etiquetas = rejilla.valores;
    }
    frames.push(frame);
    console.log(`  [ok] ${horaISO} -> ${nombrePng} (${(bufferPng.length / 1024).toFixed(0)} KB, ${width}x${height}, ${min.toFixed(1)}..${max.toFixed(1)} ${rampa.unidad})`);
  }

  // Por si una hora llegara a descargarse dos veces (no debería, fetch-arome
  // ya evita re-pedir horas ya renderizadas), nos quedamos con una entrada
  // por hora y ordenamos cronológicamente antes de escribir el manifiesto.
  const porHora = new Map();
  for (const f of frames) porHora.set(f.hora, f);
  const framesFinal = [...porHora.values()].sort((a, b) => a.hora.localeCompare(b.hora));

  // rejillaEtiquetas se guarda una vez, no por frame: la geometría de la
  // rejilla (nº de columnas/filas) es la misma para todas las horas de un
  // mismo dominio (BBOX_ESPANA es fija) — el cliente reconstruye lat/lon de
  // cada punto a partir de esto + el bbox global, sin duplicar coordenadas
  // en cada uno de los ~50 frames.
  await writeFile(manifiestoPath, JSON.stringify({
    parametro: nombreParam,
    unidad: rampa.unidad,
    ejecucion: meta.ejecucion,
    bbox: bboxGlobal,
    paradasColor: rampa.paradas,
    rejillaEtiquetas: rejillaGlobal,
    frames: framesFinal,
  }, null, 2));

  console.log(`\n${ficheros.length} frames nuevos + ${framesPrevios.length} conservados de antes = ${framesFinal.length} frames totales en ${dirSalida}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
