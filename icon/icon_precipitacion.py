# Prevision de lluvia del modelo ICON-EU del DWD (servicio meteorologico aleman) para
# el visor de rios: un PNG de valores por hora (mismo formato que los de AROME, ver
# arome/render-frames.js) recortado a la Peninsula y Baleares.
#
# ICON-EU: celdas de 0,0625° (~7 km), ejecuciones cada 3 h; las de 00, 06, 12 y 18 UTC
# llegan a 120 h (horarias hasta +78 h y de 3 en 3 despues) y terminan de publicarse
# unas 3 h 40 min despues. Datos abiertos (CC BY 4.0) en opendata.dwd.de, en GRIB2 con
# compresion CCSDS: se leen con eccodes.
#
# TOT_PREC es la lluvia acumulada desde el inicio de la ejecucion: la de cada hora es la
# diferencia entre pasos. Pasado +78 h, lo de cada tramo de 3 h se reparte a partes
# iguales entre sus 3 horas (el visor trabaja con horas sueltas).

import bz2
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import eccodes
import numpy as np
from PIL import Image

BASE = "https://opendata.dwd.de/weather/nwp/icon-eu/grib"
OESTE, SUR, ESTE, NORTE = -10.0, 35.5, 5.0, 44.5   # Peninsula y Baleares (Canarias queda fuera de ICON-EU)
PASOS = list(range(0, 79)) + list(range(81, 121, 3))
SALIDA = "data"
VALOR_SIN = 65535


def pedir(url, intentos=4):
    for i in range(intentos):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except Exception:
            if i == intentos - 1:
                raise
            time.sleep(5 * (i + 1))


def ultima_ejecucion():
    """La ejecucion de 120 h mas reciente que ya este completa: (fecha, 'HH')."""
    mejor = None
    for hh in ("00", "06", "12", "18"):
        lista = pedir(f"{BASE}/{hh}/tot_prec/").decode()
        m = re.search(r"single-level_(\d{10})_120_TOT_PREC", lista)
        if m:
            fecha = datetime.strptime(m.group(1), "%Y%m%d%H").replace(tzinfo=timezone.utc)
            if not mejor or fecha > mejor[0]:
                mejor = (fecha, hh)
    if not mejor:
        raise SystemExit("No hay ninguna ejecucion de ICON-EU completa")
    return mejor


def leer_paso(fecha, hh, paso):
    url = f"{BASE}/{hh}/tot_prec/icon-eu_europe_regular-lat-lon_single-level_{fecha:%Y%m%d%H}_{paso:03d}_TOT_PREC.grib2.bz2"
    gid = eccodes.codes_new_from_message(bz2.decompress(pedir(url)))
    try:
        ni, nj = eccodes.codes_get(gid, "Ni"), eccodes.codes_get(gid, "Nj")
        lon0 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        lat0 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        dx = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
        dy = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
        sur_norte = eccodes.codes_get(gid, "jScansPositively") == 1
        vals = eccodes.codes_get_values(gid).reshape(nj, ni)
    finally:
        eccodes.codes_release(gid)
    if lon0 > 180:
        lon0 -= 360
    if not sur_norte:   # dejar la fila 0 al sur
        vals = vals[::-1]
        lat0 -= (nj - 1) * dy
    # Celdas cuyo centro cae en la caja; fila 0 al norte
    c0, c1 = int(np.ceil((OESTE - lon0) / dx)), int(np.floor((ESTE - lon0) / dx))
    f0, f1 = int(np.ceil((SUR - lat0) / dy)), int(np.floor((NORTE - lat0) / dy))
    recorte = vals[f0:f1 + 1, c0:c1 + 1][::-1].astype(np.float64)
    rejilla = {
        "W": c1 - c0 + 1, "H": f1 - f0 + 1,
        "x0": round(lon0 + (c0 - 0.5) * dx, 6), "y0": round(lat0 + (f1 + 0.5) * dy, 6),
        "dx": dx, "dy": dy, "escala": 100, "sin": VALOR_SIN,
    }
    return recorte, rejilla


def png_valores(mm, ruta):
    c = np.where(np.isfinite(mm), np.clip(np.round(np.maximum(mm, 0) * 100), 0, VALOR_SIN - 1), VALOR_SIN).astype(np.uint16)
    rgba = np.zeros(c.shape + (4,), np.uint8)
    rgba[..., 0] = c >> 8
    rgba[..., 1] = c & 255
    rgba[..., 3] = 255
    Image.fromarray(rgba, "RGBA").save(ruta, optimize=True)


def main():
    fecha, hh = ultima_ejecucion()
    ejecucion = f"{fecha:%Y-%m-%dT%H:%M:%SZ}"
    # Ejecucion ya publicada: el manifiesto de la rama de datos (PUBLICADO = su URL)
    if os.environ.get("PUBLICADO") and "--forzar" not in sys.argv:
        try:
            if json.loads(pedir(os.environ["PUBLICADO"], 1)).get("ejecucion") == ejecucion:
                print(f"La ejecucion {ejecucion} ya esta publicada")
                return
        except Exception:
            pass   # aun no hay nada publicado
    print(f"Ejecucion {ejecucion}: {len(PASOS)} pasos")
    t0 = time.time()
    with ThreadPoolExecutor(6) as ex:
        leidos = list(ex.map(lambda p: leer_paso(fecha, hh, p), PASOS))
    print(f"  descargados en {time.time() - t0:.0f} s")
    rejilla = leidos[0][1]
    acum = [a for a, _ in leidos]

    nueva = SALIDA + ".nueva"
    shutil.rmtree(nueva, ignore_errors=True)
    os.makedirs(nueva)
    frames = []
    for i in range(1, len(PASOS)):
        p0, p1 = PASOS[i - 1], PASOS[i]
        por_hora = (acum[i] - acum[i - 1]) / (p1 - p0)
        for h in range(p0 + 1, p1 + 1):
            hora = fecha + timedelta(hours=h)
            nombre = f"{hora:%Y-%m-%dT%H-%M-%SZ}.v.png"
            png_valores(por_hora, os.path.join(nueva, nombre))
            frames.append({"hora": f"{hora:%Y-%m-%dT%H:%M:%SZ}", "valores": nombre, "ejecucion": ejecucion,
                           "max": round(float(np.nanmax(por_hora)), 1), "paso_h": p1 - p0})
    with open(os.path.join(nueva, "manifiesto.json"), "w", encoding="utf8") as f:
        json.dump({"parametro": "precipitacion", "modelo": "ICON-EU (DWD)", "unidad": "mm/h", "ejecucion": ejecucion,
                   "rejillaValores": rejilla, "frames": frames}, f, indent=1)
    # Se sustituye la carpeta entera de una vez (la ejecucion anterior no se conserva)
    shutil.rmtree(SALIDA, ignore_errors=True)
    os.rename(nueva, SALIDA)
    tam = sum(os.path.getsize(os.path.join(SALIDA, x)) for x in os.listdir(SALIDA))
    print(f"  {len(frames)} horas, rejilla {rejilla['W']}x{rejilla['H']}, {tam / 1e6:.1f} MB, en {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
