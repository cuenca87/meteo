// Cliente mínimo para la API pública de Météo-France (portail-api.meteofrance.fr).
// Requiere las credenciales OAuth2 (Basic) del portal, NUNCA embebidas en código
// que se publique en un artifact/cliente — solo uso local en Node.

const TOKEN_URL = "https://portail-api.meteofrance.fr/token";
const WCS_BASE = "https://public-api.meteofrance.fr/public/arome/1.0/wcs/MF-NWP-HIGHRES-AROME-001-FRANCE-WCS";

export async function obtenerToken(basicAuth) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token: HTTP ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

// Coverage IDs disponibles se listan con GetCapabilities; el patrón es
// PARAMETRO___YYYY-MM-DDTHH.MM.SSZ[_SUFIJO] (una franja horaria de ejecución
// del modelo agrupa TODAS las horas de pronóstico como eje "time" interno).
// El sufijo distingue variantes de acumulación (p.ej. "_PT1H" = precipitación
// acumulada en cada hora, frente a "_PT3H"/"_P1D" = ventanas más largas).
export async function obtenerUltimaEjecucion(token, parametro, sufijo = "") {
  const url = `${WCS_BASE}/GetCapabilities?service=WCS&version=2.0.1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GetCapabilities: HTTP ${res.status}`);
  const xml = await res.text();
  const re = new RegExp(`<wcs:CoverageId>(${parametro}___([0-9T:.-]+Z)${sufijo})</wcs:CoverageId>`, "g");
  let ultima = null;
  let m;
  while ((m = re.exec(xml))) {
    const [, coverageId, timestamp] = m;
    if (!ultima || timestamp > ultima.timestamp) ultima = { coverageId, timestamp };
  }
  if (!ultima) throw new Error(`No se encontró ninguna cobertura para ${parametro}${sufijo}`);
  return ultima;
}

export async function describirCobertura(token, coverageId) {
  const url = `${WCS_BASE}/DescribeCoverage?service=WCS&version=2.0.1&coverageId=${encodeURIComponent(coverageId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`DescribeCoverage: HTTP ${res.status}`);
  const xml = await res.text();
  const tiempos = [...xml.matchAll(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/g)].map((m) => m[1]);
  const inicio = tiempos[0];
  const fin = tiempos[tiempos.length - 1];
  return { xml, inicio, fin };
}

export async function obtenerCoverageGeoTiff(token, { coverageId, bbox, altura, tiempo }) {
  const [lonMin, latMin, lonMax, latMax] = bbox;
  const url = new URL(`${WCS_BASE}/GetCoverage`);
  url.searchParams.set("service", "WCS");
  url.searchParams.set("version", "2.0.1");
  url.searchParams.set("coverageId", coverageId);
  url.searchParams.set("format", "image/tiff");
  url.searchParams.set("subset", `long(${lonMin},${lonMax})`);
  url.searchParams.append("subset", `lat(${latMin},${latMax})`);
  if (altura != null) url.searchParams.append("subset", `height(${altura})`);
  url.searchParams.append("subset", `time(${tiempo})`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const texto = await res.text();
    throw new Error(`GetCoverage ${tiempo}: HTTP ${res.status} — ${texto.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
