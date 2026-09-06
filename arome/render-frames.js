// Convierte cada GeoTIFF horario en un PNG coloreado (rampa meteorológica de
// temperatura) + genera un manifiesto JSON con metadatos de cada frame para
// que el visor HTML los pueda animar sin decodificar GeoTIFF en el navegador.

import { readdir, mkdir, writeFile, readFile } from "node:fs/promises";
import { fromArrayBuffer } from "geotiff";
import { PNG } from "pngjs";

// Rampa de temperatura (°C) tipo meteorológico: violeta/azul (frío) -> verde
// -> amarillo -> naranja -> rojo/magenta (calor). Paradas y colores fijos,
// interpolación lineal en RGB entre paradas contiguas.
const PARADAS_TEMP = [
  { t: -10, color: [97, 33, 168] },
  { t: 0, color: [66, 98, 214] },
  { t: 5, color: [56, 164, 214] },
  { t: 10, color: [77, 201, 168] },
  { t: 15, color: [130, 211, 90] },
  { t: 20, color: [222, 219, 66] },
  { t: 25, color: [237, 164, 56] },
  { t: 30, color: [227, 96, 46] },
  { t: 35, color: [186, 39, 60] },
  { t: 40, color: [140, 20, 90] },
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

const RAMPAS = {
  temperatura: { paradas: PARADAS_TEMP, unidad: "°C" },
  precipitacion: { paradas: PARADAS_PRECIP, unidad: "mm/h" },
};

// Interpolación lineal (color + alfa) entre las dos paradas contiguas al valor.
function colorEnRampa(v, paradas) {
  if (v <= paradas[0].t) return [...paradas[0].color, paradas[0].a];
  const ultima = paradas[paradas.length - 1];
  if (v >= ultima.t) return [...ultima.color, ultima.a];
  for (let i = 0; i < paradas.length - 1; i++) {
    const a = paradas[i];
    const b = paradas[i + 1];
    if (v >= a.t && v <= b.t) {
      const f = (v - a.t) / (b.t - a.t);
      return [
        Math.round(a.color[0] + (b.color[0] - a.color[0]) * f),
        Math.round(a.color[1] + (b.color[1] - a.color[1]) * f),
        Math.round(a.color[2] + (b.color[2] - a.color[2]) * f),
        Math.round(a.a + (b.a - a.a) * f),
      ];
    }
  }
  return [...ultima.color, ultima.a];
}

// Factor de diezmado (nearest-neighbor): la resolución nativa (0.01°, ~1.1 km)
// es mucho más fina de lo necesario para un mapa animado a escala regional, y
// al automatizarse vía GitHub Actions (cada 3h) conviene mantener el peso de
// cada tanda de frames moderado.
const DIEZMADO = 2;

async function tiffAPng(rutaTiff, paradas) {
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

  return { png, width, height, bbox, min, max };
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

  const frames = [];
  let bboxGlobal = null;
  for (const fichero of ficheros) {
    const horaISO = fichero.replace(/\.tiff$/, "").replace(/(\d{2})-(\d{2})-(\d{2})Z$/, "$1:$2:$3Z");
    const { png, width, height, bbox, min, max } = await tiffAPng(`${dirEntrada}/${fichero}`, rampa.paradas);
    bboxGlobal = bbox;
    const nombrePng = fichero.replace(/\.tiff$/, ".png");
    const bufferPng = PNG.sync.write(png);
    await writeFile(`${dirSalida}/${nombrePng}`, bufferPng);
    frames.push({ hora: horaISO, archivo: nombrePng, min: Number(min.toFixed(1)), max: Number(max.toFixed(1)) });
    console.log(`  [ok] ${horaISO} -> ${nombrePng} (${(bufferPng.length / 1024).toFixed(0)} KB, ${width}x${height}, ${min.toFixed(1)}..${max.toFixed(1)} ${rampa.unidad})`);
  }

  await writeFile(`${dirSalida}/manifiesto.json`, JSON.stringify({
    parametro: nombreParam,
    unidad: rampa.unidad,
    ejecucion: meta.ejecucion,
    bbox: bboxGlobal,
    paradasColor: rampa.paradas,
    frames,
  }, null, 2));

  console.log(`\n${frames.length} frames renderizados en ${dirSalida}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
