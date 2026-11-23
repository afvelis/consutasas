#!/usr/bin/env python3
"""ConsuTasas: construye `rates.json` (BCV + Binance P2P + Bybit P2P) server-side.

Diseñado para correr dentro de un GitHub Action (Python 3.12 stdlib + requests +
beautifulsoup4) y también localmente. Toma un snapshot de tasas, agrega el
dashboard tipo `consuTasas.py` y escribe el JSON final sin NaN/Infinity.

Lógica de scraping/peticiones adaptada (solo lectura) de calculadora_tasas.py:
- BCV: https://www.bcv.org.ve/ con verify=False; fallback ve.dolarapi.com.
- Binance: POST a p2p.binance.com, tradeType BUY = usuario compra USDT, SELL = vende.
- Bybit: POST a api2.bybit.com, side "1" = usuario compra, "0" = vende.
"""

import argparse
import json
import math
import statistics
import sys
import time
import warnings
from datetime import datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

try:
    from zoneinfo import ZoneInfo
    TZ_CARACAS = ZoneInfo("America/Caracas")
except Exception:  # sin tzdata
    TZ_CARACAS = timezone(timedelta(hours=-4))

# Deprecation/simplefilter NO se usa directo: silencia el aviso de TLS del BCV.
warnings.filterwarnings("ignore", message="Unverified HTTPS request")

FIATS = ["VES", "PEN", "CLP", "COP", "MXN"]
PAGES = [1, 2]
ROWS = 20
TIMEOUT_P2P = (10, 20)
TIMEOUT_BCV = (10, 25)

BCV_URL = "https://www.bcv.org.ve/"
DOLARAPI_USD_URL = "https://ve.dolarapi.com/v1/dolares"
DOLARAPI_EUR_URL = "https://ve.dolarapi.com/v1/euros"
FRANKFURTER_URL = "https://api.frankfurter.app/latest?from=EUR&to=USD"
ERAPI_EUR_URL = "https://open.er-api.com/v6/latest/EUR"
BINANCE_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search"
BYBIT_URL = "https://api2.bybit.com/fiat/otc/item/online"

_UA_CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
# Headers calcados de _HEADERS_BINANCE / _HEADERS_BYBIT del módulo original.
HEADERS_BINANCE = {"content-type": "application/json", "user-agent": "Mozilla/5.0"}
HEADERS_BYBIT = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "es-ES,es;q=0.9",
    "Origin": "https://www.bybit.com",
    "Referer": "https://www.bybit.com/es-ES/p2p/buy/USDT/VES",
    "User-Agent": _UA_CHROME,
}
HEADERS_BCV = {"User-Agent": _UA_CHROME}


class SinConexion(Exception):
    """HTTP >=400, red caída, timeout o respuesta malformada: no hay datos fiables."""


def _limpiar_precio(valor):
    """float solo si es finito y > 0; descarta NaN/inf/0/negativos."""
    try:
        precio = float(valor)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(precio) or precio <= 0:
        return None
    return precio


def _pedir_con_reintento(hacer):
    """Ejecuta la petición 2 veces (red inestable en runners); relanza SinConexion."""
    ultimo = None
    for intento in range(2):
        try:
            return hacer()
        except requests.exceptions.RequestException as exc:
            ultimo = exc
            if intento == 0:
                time.sleep(2)
    raise SinConexion(f"{type(ultimo).__name__}: {ultimo}") from ultimo


# ==================== BINANCE ====================

def _registro_binance(adv, page):
    """Anuncio Binance → registro {price, min, max, available, platform, page}.

    Sin precio utilizable se descarta el anuncio (el agregado de precios no cambia).
    Los campos que falten quedan en null (nunca se inventa).
    """
    precio = _limpiar_precio(adv.get("price"))
    if precio is None:
        return None
    return {
        "price": precio,
        "min": _limpiar_precio(adv.get("minSingleTransAmount")),
        "max": _limpiar_precio(adv.get("maxSingleTransAmount")),
        # disponible restante del anuncio (surplusAmount); tradableQuantity queda fuera:
        # es el límite comerciable por orden, no el disponible del anuncio.
        "available": _limpiar_precio(adv.get("surplusAmount")),
        "platform": "binance",
        "page": page,
    }


def _peticion_binance(trade_type, fiat, page, rows=ROWS):
    """trade_type BUY = usuario compra USDT (tasa compra); SELL = vende.

    Devuelve anuncios completos (no solo precios) para conservar min/max/available.
    """
    payload = {
        "asset": "USDT",
        "fiat": fiat,
        "tradeType": trade_type,
        "page": page,
        "rows": rows,
        "payTypes": [],
        "proMerchantAds": False,
        "shieldMerchantAds": False,
        "publisherType": None,
        "classifies": ["mass", "profession", "fiat_trade"],
    }
    def hacer():
        resp = requests.post(BINANCE_URL, json=payload,
                             headers=HEADERS_BINANCE, timeout=TIMEOUT_P2P)
        if resp.status_code >= 400:
            raise SinConexion(f"Binance P2P devolvió HTTP {resp.status_code}")
        return resp
    resp = _pedir_con_reintento(hacer)
    datos = resp.json()
    if not isinstance(datos, dict):
        raise SinConexion("Binance P2P devolvió JSON no-dict")
    items = datos.get("data")
    if not isinstance(items, list):
        raise SinConexion("Binance P2P: 'data' no es lista")
    registros = []
    for item in items:
        adv = item.get("adv") if isinstance(item, dict) else None
        registro = _registro_binance(adv, page) if isinstance(adv, dict) else None
        if registro is not None:
            registros.append(registro)
    return resp.status_code, registros


# ==================== BYBIT ====================

def _registro_bybit(item, page):
    """Anuncio Bybit → registro {price, min, max, available, platform, page}.

    lastQuantity = restante del anuncio (quantity es el total original).
    """
    precio = _limpiar_precio(item.get("price"))
    if precio is None:
        return None
    return {
        "price": precio,
        "min": _limpiar_precio(item.get("minAmount")),
        "max": _limpiar_precio(item.get("maxAmount")),
        "available": _limpiar_precio(item.get("lastQuantity")),
        "platform": "bybit",
        "page": page,
    }


def _peticion_bybit(side, fiat, page, size=ROWS):
    """side "1" = usuario compra USDT (tasa compra); "0" = vende."""
    payload = {
        "userId": "",
        "tokenId": "USDT",
        "currencyId": fiat,
        "side": side,
        "size": str(size),
        "page": str(page),
        "amount": "",
        "authMaker": "false",
        "canTrade": "false",
        "itemRegion": "2",
    }
    def hacer():
        resp = requests.post(BYBIT_URL, data=payload,
                             headers=HEADERS_BYBIT, timeout=TIMEOUT_P2P)
        if resp.status_code >= 400:
            raise SinConexion(f"Bybit P2P devolvió HTTP {resp.status_code}")
        return resp
    resp = _pedir_con_reintento(hacer)
    datos = resp.json()
    if not isinstance(datos, dict):
        raise SinConexion("Bybit P2P devolvió JSON no-dict")
    ret_code = datos.get("ret_code")
    if ret_code is not None and ret_code != 0:
        raise SinConexion(f"Bybit ret_code={ret_code}: {datos.get('ret_msg')}")
    result = datos.get("result")
    if not isinstance(result, dict):
        raise SinConexion("Bybit P2P: 'result' no es dict")
    items = result.get("items")
    if not isinstance(items, list):
        raise SinConexion("Bybit P2P: 'items' no es lista")
    registros = []
    for item in items:
        registro = _registro_bybit(item, page) if isinstance(item, dict) else None
        if registro is not None:
            registros.append(registro)
    return resp.status_code, registros


# ==================== BCV ====================

def _parsear_bcv_bloque(soup):
    """Extrae usd/eur/fecha del HTML del BCV (formato es-VE: punto=miles, coma=decimal)."""
    fecha_texto = None
    fecha_div = soup.find("div", id="fecha")
    if fecha_div:
        fecha_texto = fecha_div.get_text(strip=True)
    else:
        marcador = soup.find(string=lambda t: t and "Fecha Valor" in t)
        if marcador:
            span = marcador.find_next("span")
            fecha_texto = span.get_text(strip=True) if span else marcador.strip()
    resultado = {
        "actualizado": fecha_texto.replace("Fecha Valor:", "").strip() if fecha_texto else "No disponible",
        "fuente": "BCV-Web",
    }
    for clave, div_id in (("usd", "dolar"), ("eur", "euro")):
        bloque = soup.find("div", id=div_id)
        strong = bloque.find("strong") if bloque else None
        if strong is None:
            continue
        tasa = strong.get_text(strip=True).replace(".", "").replace(",", ".")
        precio = _limpiar_precio(tasa)
        if precio is not None:
            resultado[clave] = precio
    return resultado if "usd" in resultado or "eur" in resultado else None


def _dolarapi_oficial(url, etiqueta):
    """Tasa oficial de ve.dolarapi.com: item con oficial=true -> promedio."""
    def hacer():
        resp = requests.get(url, headers=HEADERS_BCV, timeout=TIMEOUT_BCV)
        if resp.status_code >= 400:
            raise SinConexion(f"dolarapi {etiqueta}: HTTP {resp.status_code}")
        return resp
    resp = _pedir_con_reintento(hacer)
    datos = resp.json()
    if not isinstance(datos, list):
        raise SinConexion(f"dolarapi {etiqueta}: JSON no-lista")
    for item in datos:
        if isinstance(item, dict) and item.get("oficial") is True:
            precio = _limpiar_precio(item.get("promedio"))
            if precio is None:
                raise SinConexion(f"dolarapi {etiqueta}: promedio no numérico {item.get('promedio')!r}")
            return precio, item.get("fechaActualizacion"), resp.status_code
    raise SinConexion(f"dolarapi {etiqueta}: sin item oficial")


def obtener_bcv():
    """BCV: scraping de bcv.org.ve (verify=False); fallback ve.dolarapi.com."""
    resultado = {"status": "fallo", "http": None, "url": BCV_URL, "usd": None,
                 "eur": None, "actualizado": None, "fuente": None}
    warnings_texto = []
    try:
        def hacer():
            # verify=False solo para el BCV: cadenas del sitio cambian con frecuencia.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                return requests.get(BCV_URL, headers=HEADERS_BCV,
                                    timeout=TIMEOUT_BCV, verify=False)
        resp = _pedir_con_reintento(hacer)
        resultado["http"] = resp.status_code
        parseo = _parsear_bcv_bloque(BeautifulSoup(resp.text, "html.parser"))
        if parseo is None:
            raise SinConexion("BCV: HTML sin bloques usd/eur")
        resultado["usd"] = parseo.get("usd")
        resultado["eur"] = parseo.get("eur")
        resultado["actualizado"] = parseo.get("actualizado")
        resultado["fuente"] = "BCV-Web"
    except Exception as exc:
        warnings_texto.append(f"BCV web falló ({exc}); probando ve.dolarapi.com")
        resultado["_fallback_motivo"] = str(exc)

    # Fallback por moneda: permite parcial (una moneda sí, la otra no).
    if resultado["usd"] is None:
        try:
            usd, fecha, http = _dolarapi_oficial(DOLARAPI_USD_URL, "usd")
            resultado["usd"] = usd
            if resultado["actualizado"] in (None, "No disponible"):
                resultado["actualizado"] = fecha
            resultado["fuente"] = "dolarapi-fallback"
            resultado["http"] = http
        except Exception as exc:
            warnings_texto.append(str(exc))
    if resultado["eur"] is None:
        try:
            eur, _, http = _dolarapi_oficial(DOLARAPI_EUR_URL, "eur")
            resultado["eur"] = eur
            resultado["fuente"] = "dolarapi-fallback"
            resultado["http"] = http
        except Exception as exc:
            warnings_texto.append(str(exc))

    tiene_usd = resultado["usd"] is not None
    tiene_eur = resultado["eur"] is not None
    if not resultado["fuente"]:
        resultado["status"] = "fallo"
    elif resultado["fuente"] == "BCV-Web" and tiene_usd and tiene_eur:
        resultado["status"] = "ok"
    else:
        resultado["status"] = "parcial" if (tiene_usd or tiene_eur) else "fallo"
    resultado["warnings"] = warnings_texto
    return resultado


# ==================== EUR/USD REFERENCIAL (sin P2P EUR) ====================

def _tasa_eur_usd():
    """EUR/USD referencial: Frankfurter (ECB) primario; fallback open.er-api.com.

    Devuelve (usd | None, fuente | None). Sin inventar: si ambas fallan → (None, None).
    """
    for nombre, url in (("frankfurter", FRANKFURTER_URL), ("erapi", ERAPI_EUR_URL)):
        try:
            def hacer():
                resp = requests.get(url, headers=HEADERS_BCV, timeout=TIMEOUT_BCV)
                if resp.status_code >= 400:
                    raise SinConexion(f"{nombre} devolvió HTTP {resp.status_code}")
                return resp
            resp = _pedir_con_reintento(hacer)
            datos = resp.json()
            if not isinstance(datos, dict):
                raise SinConexion(f"{nombre}: JSON no-dict")
            if nombre == "erapi" and datos.get("result") != "success":
                raise SinConexion(f"erapi: result={datos.get('result')!r}")
            usd = _limpiar_precio((datos.get("rates") or {}).get("USD"))
            if usd is None:
                raise SinConexion(f"{nombre}: rates.USD no utilizable")
            return usd, nombre
        except (SinConexion, ValueError):
            continue
    return None, None


def _construir_eur_ref(tasa, fuente, bcv, ahora):
    """eurRef: referencia ECB/er-api combinada con el BCV del snapshot.

    ves = BCV EUR/VES; vesImplicito = usd × BCV USD/VES (implícito del par);
    diffPct = (ves - vesImplicito) / vesImplicito * 100.
    Si no hay tasa referencial, status='fallo' con usd/source null. Si la tasa está
    pero el BCV no trae usd o eur, no se inventa nada: status='parcial' y nulls.
    """
    eur_ref = {"usd": None, "ves": None, "vesImplicito": None, "diffPct": None,
               "source": None,
               "fetchedAt": ahora.isoformat(timespec="seconds").replace("+00:00", "Z"),
               "status": "fallo"}
    if tasa is None:
        return eur_ref
    eur_ref["usd"] = tasa
    eur_ref["source"] = fuente
    bcv_eur, bcv_usd = bcv.get("eur"), bcv.get("usd")
    if bcv_eur is None or bcv_usd is None:
        eur_ref["status"] = "parcial"
        return eur_ref
    eur_ref["ves"] = round(bcv_eur, 4)
    eur_ref["vesImplicito"] = round(tasa * bcv_usd, 4)
    eur_ref["diffPct"] = _pct(eur_ref["vesImplicito"], eur_ref["ves"])
    eur_ref["status"] = "ok"
    return eur_ref


# ==================== DESCARGA P2P (con estado por fuente) ====================

def _descargar_fuente(plataforma, fiats):
    """Descarga el libro P2P de una plataforma. Devuelve (datos, counts, status).

    datos[fiat][lado] = {page: [anuncios|None]}, lado: 'compra' (usuario compra
    USDT, BUY/side 1) o 'venta' (vende, SELL/side 0). Cada anuncio es un registro
    {price, min, max, available, platform, page}.
    status: 'ok' si todos los requests y cada (fiat, lado) tuvieron >=5 anuncios
    acumulados; 'parcial' si algún request falló o hubo lados con pocos; 'fallo'
    si todo falló. Nunca lanza: una fuente caída no mata el snapshot.
    """
    datos = {}
    counts = {"requests": 0, "ok": 0, "fallos": 0}
    peticiones = []
    if plataforma == "binance":
        peticiones = [("compra", "BUY"), ("venta", "SELL")]
    else:
        peticiones = [("compra", "1"), ("venta", "0")]
    errores = []
    for fiat in fiats:
        datos[fiat] = {}
        for lado, etiqueta in peticiones:
            datos[fiat][lado] = {}
            for page in PAGES:
                try:
                    if plataforma == "binance":
                        http, anuncios = _peticion_binance(etiqueta, fiat, page)
                    else:
                        http, anuncios = _peticion_bybit(etiqueta, fiat, page)
                    datos[fiat][lado][page] = anuncios
                    counts["ok"] += 1
                except SinConexion as exc:
                    datos[fiat][lado][page] = None
                    counts["fallos"] += 1
                    errores.append(f"{plataforma} {fiat} {lado} p{page}: {exc}")
                counts["requests"] += 1
            # fin pages
        # fin lados
    por_lado_minimo = []
    for fiat in fiats:
        for lado, _ in peticiones:
            total = sum(len(p) for p in datos[fiat][lado].values() if p is not None)
            if total > 0 and total < 5:
                por_lado_minimo.append(f"{plataforma} {fiat} {lado}: solo {total} anuncios")
    if counts["fallos"] == counts["requests"] and counts["requests"] > 0:
        status = "fallo"
    elif counts["fallos"] or por_lado_minimo:
        status = "parcial"
    else:
        status = "ok"
    warnings_texto = errores + por_lado_minimo
    return datos, counts, status, warnings_texto


# ==================== AGREGACIÓN ====================

def _promedio(precios):
    return statistics.fmean(precios) if precios else None


def _pct(deno, num):
    return round((num - deno) / deno * 100, 2) if deno and num and deno > 0 else None


def _agregar_lado(lados_por_page):
    """De {page: [anuncios|null]} a (media, mejor_min_o_max, promedios por página, n).

    compra: mejor = mínimo (usuario paga menos por USDT).
    venta: mejor = máximo (usuario recibe más por USDT).
    Usa solo el precio de cada registro de anuncio (igual que antes de conservar ads).
    """
    todos = [a for page in PAGES for a in (lados_por_page.get(page) or [])]
    precios = [a["price"] for a in todos]
    media = _promedio(precios)
    promedios_page = {f"page{p}": (round(m, 4) if (m := _promedio(
        [a["price"] for a in (lados_por_page.get(p) or [])])) is not None else None)
        for p in PAGES}
    return media, promedios_page, len(precios), precios


def _top_ads(lados_por_page, descendente):
    """Top 20 de anuncios combinados de un lado (Binance+Bybit, páginas 1-2).

    compra ascendente (mejor = precio más bajo para comprar USDT);
    venta descendente (mejor = precio más alto al vender USDT).
    """
    todos = [a for p in PAGES for a in (lados_por_page.get(p) or [])]
    ordenados = sorted(todos, key=lambda a: a["price"], reverse=descendente)
    return ordenados[:20]


def _agregar_par(plataforma_datos_binance, plataforma_datos_bybit, fiat):
    """Agrega un fiat combinando Binance+Bybit (páginas 1-2, lados compra/venta)."""
    fuente_lados = {}
    for nombre, datos in (("binance", plataforma_datos_binance), ("bybit", plataforma_datos_bybit)):
        fuente_lados[nombre] = {
            "compra": (datos.get(fiat, {}).get("compra") or {}),
            "venta": (datos.get(fiat, {}).get("venta") or {}),
        }
    compra_ads = {p: [a for fuente in fuente_lados.values()
                      for a in (fuente["compra"].get(p) or [])] for p in PAGES}
    venta_ads = {p: [a for fuente in fuente_lados.values()
                     for a in (fuente["venta"].get(p) or [])] for p in PAGES}
    compra_media, compra_pages, n_compra, compra_todos = _agregar_lado(compra_ads)
    venta_media, venta_pages, n_venta, venta_todos = _agregar_lado(venta_ads)

    estados_plataforma = {}
    for nombre, fuente in fuente_lados.items():
        n_com = sum(len(fuente["compra"].get(p) or []) for p in PAGES)
        n_ven = sum(len(fuente["venta"].get(p) or []) for p in PAGES)
        estados_plataforma[nombre] = {
            "compra": round(compra_media_pl, 4) if (compra_media_pl := _promedio(
                [a["price"] for p in PAGES for a in (fuente["compra"].get(p) or [])])) else None,
            "venta": round(venta_media_pl, 4) if (venta_media_pl := _promedio(
                [a["price"] for p in PAGES for a in (fuente["venta"].get(p) or [])])) else None,
            "muestras": {"compra": n_com, "venta": n_ven},
        }

    tiene_compra = compra_media is not None
    tiene_venta = venta_media is not None
    if tiene_compra and tiene_venta:
        status = "ok"
    elif tiene_compra or tiene_venta:
        status = "parcial"
    else:
        status = "fallo"
    mejor_compra = min(compra_todos) if compra_todos else None
    mejor_venta = max(venta_todos) if venta_todos else None
    par = {
        "code": fiat,
        "status": status,
        "compra": round(compra_media, 4) if tiene_compra else None,
        "venta": round(venta_media, 4) if tiene_venta else None,
        "spreadPct": _pct(compra_media, venta_media),
        "mejorCompra": round(mejor_compra, 4) if mejor_compra else None,
        "mejorVenta": round(mejor_venta, 4) if mejor_venta else None,
        "mejorSpreadPct": _pct(mejor_compra, mejor_venta),
        "muestras": {"buy": n_compra, "sell": n_venta, "total": n_compra + n_venta},
        "promediosPorPagina": {"compra": compra_pages, "venta": venta_pages},
        "porPlataforma": estados_plataforma,
        "ads": {"compra": _top_ads(compra_ads, descendente=False),
                "venta": _top_ads(venta_ads, descendente=True)},
    }
    return par


def _detail_ves(binance, bybit):
    """vesDetail: VES combinado con detalle por página (spec del dashboard)."""
    par = _agregar_par(binance, bybit, "VES")
    return {
        "compraTotal": par["compra"],
        "ventaTotal": par["venta"],
        "mejorPrecioCompra": par["mejorCompra"],
        "mejorPrecioVenta": par["mejorVenta"],
        "compraPromP1": par["promediosPorPagina"]["compra"]["page1"],
        "compraPromP2": par["promediosPorPagina"]["compra"]["page2"],
        "ventaPromP1": par["promediosPorPagina"]["venta"]["page1"],
        "ventaPromP2": par["promediosPorPagina"]["venta"]["page2"],
        "spreadTotal": par["spreadPct"],
        "spreadMejores": par["mejorSpreadPct"],
        "muestras": {"compra": par["muestras"]["buy"], "venta": par["muestras"]["sell"]},
        "status": par["status"],
    }


# ==================== CROSS / VARIACIONES / PODER ADQUISITIVO ====================

def _tasa_p2p_ves(pares, plataforma):
    por_pl = pares.get("VES", {}).get("porPlataforma", {})
    return (por_pl.get(plataforma, {}) or {}).get("venta")


def _construir_cross(pares, bcv):
    """Cotizaciones cruzadas con rate USD→VES = venta (lo que recibes por vender USDT)."""
    usd, eur = bcv.get("usd"), bcv.get("eur")
    binance = _tasa_p2p_ves(pares, "binance")
    bybit = _tasa_p2p_ves(pares, "bybit")
    contenidos = {
        "BCV USD → Binance VES": (usd, binance),
        "BCV USD → Bybit VES": (usd, bybit),
        "Binance VES → Bybit VES": (binance, bybit),
        "BCV USD → BCV EUR": (usd, eur),
        "BCV EUR → Binance VES": (eur, binance),
        "BCV EUR → Bybit VES": (eur, bybit),
    }
    cross = {}
    variaciones = []
    for nombre, (origen, destino) in contenidos.items():
        pct = _pct(origen, destino) if (origen and destino) else None
        cross[nombre] = {"origen": origen, "destino": destino, "pctVariacion": pct}
        if pct is not None:
            variaciones.append({"name": nombre, "pct": pct})
    return cross, variaciones


def _construir_poder_adquisitivo(pares, bcv):
    """Pérdida frente al oficial: (p2p - bcv)/p2p*100 y factor p2p/bcv."""
    usd, eur = bcv.get("usd"), bcv.get("eur")
    binance = _tasa_p2p_ves(pares, "binance")
    bybit = _tasa_p2p_ves(pares, "bybit")
    contenidos = {
        "BCV USD → Binance VES": (binance, usd),
        "BCV USD → Bybit VES": (bybit, usd),
        "BCV EUR → Binance VES": (binance, eur),
        "BCV EUR → Bybit VES": (bybit, eur),
    }
    lista = []
    for nombre, (p2p, oficial) in contenidos.items():
        if not (p2p and oficial):
            lista.append({"name": nombre, "lossPct": None, "factor": None})
            continue
        lista.append({
            "name": nombre,
            "lossPct": round((p2p - oficial) / p2p * 100, 2),
            "factor": round(p2p / oficial, 4),
        })
    return lista


# ==================== SANITIZADO / SALIDA ====================

def _sanitizar(obj):
    """Reemplaza NaN/Infinity por None (JSON sin valores no finitos)."""
    if isinstance(obj, dict):
        return {k: _sanitizar(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitizar(v) for v in obj]
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def _diagnostics(counts_b, counts_bv, elapsed_s):
    return {
        "binanceRequests": counts_b,
        "bybitRequests": counts_bv,
        "elapsedSeconds": round(elapsed_s, 2),
        "pagePromedios": "media simple (fmean) por página y lado; promediosPorPagina usa"
                         " solo la página indicada",
    }


def construir_snapshot():
    iniciado = time.monotonic()
    warnings_out = []
    bcv = obtener_bcv()
    warnings_out.extend(bcv.pop("warnings", []))
    bcv.pop("_fallback_motivo", None)

    binance_datos, binance_counts, binance_status, binance_warns = \
        _descargar_fuente("binance", FIATS)
    bybit_datos, bybit_counts, bybit_status, bybit_warns = \
        _descargar_fuente("bybit", FIATS)
    warnings_out.extend(binance_warns)
    warnings_out.extend(bybit_warns)

    eur_usd, eur_fuente = _tasa_eur_usd()

    pares = {}
    for fiat in FIATS:
        pares[fiat] = _agregar_par(binance_datos, bybit_datos, fiat)

    ves_detail = _detail_ves(binance_datos, bybit_datos)
    cross, variaciones = _construir_cross(pares, bcv)
    poder = _construir_poder_adquisitivo(pares, bcv)

    generated = datetime.now(timezone.utc)
    eur_ref = _construir_eur_ref(eur_usd, eur_fuente, bcv, generated)
    if eur_ref["status"] == "fallo":
        warnings_out.append("EUR/USD referencial no disponible (Frankfurter y "
                            "er-api fallaron): EUR queda en modo manual/BCV implícito")
    snapshot = {
        "schema": "consutasas/rates.v1",
        "generatedAt": generated.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "generatedAtCaracas": generated.astimezone(TZ_CARACAS)
            .isoformat(timespec="seconds"),
        "sources": {
            "bcv": {"status": bcv["status"], "http": bcv["http"],
                    "samples": {"usd": bcv["usd"], "eur": bcv["eur"]},
                    "url": BCV_URL, "fuente": bcv["fuente"],
                    "actualizado": bcv["actualizado"]},
            "binance": {"status": binance_status, "http": 200 if binance_counts["ok"] else None,
                        "samples": {"ads": _total_ads(binance_datos)},
                        "url": BINANCE_URL},
            "bybit": {"status": bybit_status, "http": 200 if bybit_counts["ok"] else None,
                      "samples": {"ads": _total_ads(bybit_datos)},
                      "url": BYBIT_URL},
        },
        "pairs": pares,
        "vesDetail": ves_detail,
        "eurRef": eur_ref,
        "cross": cross,
        "variations": variaciones,
        "purchasingPower": poder,
        "diagnostics": _diagnostics(binance_counts, bybit_counts, time.monotonic() - iniciado),
        "warnings": warnings_out,
        "meta": {"pages": max(PAGES), "rows": ROWS, "fiats": FIATS,
                 "schemaVersion": "2"},
    }
    return _sanitizar(snapshot)


def _total_ads(datos):
    total = 0
    for fiat in FIATS:
        for lado in ("compra", "venta"):
            for page in PAGES:
                precios = (datos.get(fiat, {}).get(lado, {}) or {}).get(page)
                if isinstance(precios, list):
                    total += len(precios)
    return total


def _imprimir_resumen(s):
    bcv = s["sources"]["bcv"]
    print("=" * 72)
    print(f"ConsuTasas snapshot {s['generatedAt']} (Caracas {s['generatedAtCaracas']})")
    print("=" * 72)
    print(f"BCV [{bcv['status']}] fuente={bcv['fuente']} "
          f"USD={bcv['samples']['usd']} EUR={bcv['samples']['eur']} "
          f"actualizado={bcv['actualizado']!r}")
    eur = s["eurRef"]
    print(f"eurRef [{eur['status']}] fuente={eur['source']} USD={eur['usd']} "
          f"fetchedAt={eur['fetchedAt']}")
    if eur["ves"] is not None:
        print(f"eurRef EUR→VES: BCV={eur['ves']} implícito={eur['vesImplicito']} "
              f"diff={eur['diffPct']}%")
    ves = s["pairs"]["VES"]
    for plataforma in ("binance", "bybit"):
        d = ves["porPlataforma"].get(plataforma, {})
        if d:
            print(f"{plataforma.upper()} VES (VES): compra={d['compra']} venta={d['venta']} "
                  f"muestras={d['muestras']}")
    print("-" * 72)
    print(f"{'par':<6}{'status':<9}{'compra':>12}{'venta':>12}{'spread%':>9}"
          f"{'mejC':>12}{'mejV':>12}{'muestras':>10}")
    for fiat in FIATS:
        p = s["pairs"][fiat]
        def _f(x, w):
            return f"{x:>{w}.2f}" if isinstance(x, float) else f"{'—':>{w}}"
        print(f"{p['code']:<6}{p['status']:<9}"
              f"{_f(p['compra'], 12)}{_f(p['venta'], 12)}{_f(p['spreadPct'], 9)}"
              f"{_f(p['mejorCompra'], 12)}{_f(p['mejorVenta'], 12)}"
              f"{p['muestras']['total']:>10}")
    print("-" * 72)
    for fiat in FIATS:
        ads = s["pairs"][fiat].get("ads") or {}
        print(f"ads {fiat}: compra={len(ads.get('compra') or [])} "
              f"venta={len(ads.get('venta') or [])}")
    print("-" * 72)
    for item in s["purchasingPower"]:
        if item["lossPct"] is not None:
            print(f"poder adquisitivo {item['name']}: pérdida {item['lossPct']}% "
                  f"factor {item['factor']}")
    if s["warnings"]:
        print(f"avisos ({len(s['warnings'])}):")
        for aviso in s["warnings"]:
            print(f"  - {aviso}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Genera rates.json de ConsuTasas")
    parser.add_argument("--out", default="rates.json", help="ruta del JSON de salida")
    args = parser.parse_args(argv)
    snapshot = construir_snapshot()
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    _imprimir_resumen(snapshot)
    print(f"\nescrito: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
