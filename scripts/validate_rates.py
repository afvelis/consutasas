#!/usr/bin/env python3
"""Valida `rates.json` de ConsuTasas (schema v2): ads por fiat/lado + eurRef.

Cobertura mínima del snapshot generado por `build_rates.py`:
- pairs[FIAT].ads: compra/venta presentes, ordenados (compra asc, venta desc),
  top <=20, campos price/min/max/available/platform/page presentes.
- eurRef: usd finito > 0; ves/vesImplicito/diffPct coherentes si status=ok.
- Secciones preexistentes intactas: pairs y vesDetail presentes.
Uso: python3 scripts/validate_rates.py [ruta=rates.json]
Exit 0 = válido; exit 1 = alguna validación falló.
"""

import json
import math
import sys

FIATS = ["VES", "PEN", "CLP", "COP", "MXN"]
ADS_LIMITE = 20


def _fallo(msg, errores):
    errores.append(msg)


def _num(x, clave, errores, contexto):
    if not isinstance(x, (int, float)) or isinstance(x, bool) \
            or not math.isfinite(x) or x <= 0:
        _fallo(f"{contexto}: {clave} no es número finito > 0 ({x!r})", errores)


def validar_ads(par, errores):
    ads = par.get("ads")
    code = par.get("code", "?")
    if not isinstance(ads, dict):
        _fallo(f"pairs.{code}.ads no es objeto", errores)
        return
    for lado, descendente in (("compra", False), ("venta", True)):
        lista = ads.get(lado)
        if not isinstance(lista, list):
            _fallo(f"pairs.{code}.ads.{lado} no es lista", errores)
            continue
        if len(lista) == 0:
            _fallo(f"pairs.{code}.ads.{lado} está vacío", errores)
            continue
        if len(lista) > ADS_LIMITE:
            _fallo(f"pairs.{code}.ads.{lado} supera top {ADS_LIMITE} ({len(lista)})", errores)
        precios = []
        for i, ad in enumerate(lista):
            contexto = f"pairs.{code}.ads.{lado}[{i}]"
            if not isinstance(ad, dict):
                _fallo(f"{contexto} no es objeto", errores)
                continue
            _num(ad.get("price"), "price", errores, contexto)
            if ad.get("min") is not None:
                _num(ad.get("min"), "min", errores, contexto)
            if ad.get("max") is not None:
                _num(ad.get("max"), "max", errores, contexto)
            if ad.get("available") is not None:
                _num(ad.get("available"), "available", errores, contexto)
            if ad.get("platform") not in ("binance", "bybit"):
                _fallo(f"{contexto}: platform inesperada ({ad.get('platform')!r})", errores)
            if ad.get("page") not in (1, 2):
                _fallo(f"{contexto}: page inesperada ({ad.get('page')!r})", errores)
            precios.append(ad.get("price"))
        if any(p is None for p in precios):
            continue  # price inválido ya reportado; no comparar orden
        if any(precios[i] > precios[i + 1] for i in range(len(precios) - 1)) and not descendente:
            _fallo(f"pairs.{code}.ads.{lado} no está ordenado ascendente", errores)
        if any(precios[i] < precios[i + 1] for i in range(len(precios) - 1)) and descendente:
            _fallo(f"pairs.{code}.ads.{lado} no está ordenado descendente", errores)


def validar_eur_ref(s, errores):
    eur = s.get("eurRef")
    if not isinstance(eur, dict):
        _fallo("eurRef no existe o no es objeto", errores)
        return
    for clave in ("usd", "ves", "vesImplicito", "diffPct", "source", "fetchedAt", "status"):
        if clave not in eur:
            _fallo(f"eurRef sin clave {clave}", errores)
    status = eur.get("status")
    usd = eur.get("usd")
    if status not in ("ok", "parcial", "fallo"):
        _fallo(f"eurRef.status inesperado ({status!r})", errores)
    if usd is not None:
        _num(usd, "usd", errores, "eurRef")
    if status == "fallo":
        if usd is not None or eur.get("source") is not None:
            _fallo("eurRef fallo debe traer usd/source null", errores)
    if status == "ok":
        if eur.get("source") not in ("frankfurter", "erapi"):
            _fallo(f"eurRef.source inesperado ({eur.get('source')!r})", errores)
        ves, impl, pct = eur.get("ves"), eur.get("vesImplicito"), eur.get("diffPct")
        for clave, valor in (("ves", ves), ("vesImplicito", impl)):
            if valor is None:
                _fallo(f"eurRef ok sin {clave}", errores)
            else:
                _num(valor, clave, errores, "eurRef")
        if ves and impl:
            esperado = (ves - impl) / impl * 100
            if pct is None or abs(pct - esperado) > 0.05:
                _fallo(f"eurRef.diffPct incoherente ({pct} vs {esperado:.2f})", errores)


def validar(archivo):
    errores = []
    with open(archivo, encoding="utf-8") as fh:
        s = json.load(fh)
    pares = s.get("pairs")
    if not isinstance(pares, dict):
        _fallo("pairs no existe o no es objeto", errores)
    else:
        for fiat in FIATS:
            par = pares.get(fiat)
            if not isinstance(par, dict):
                _fallo(f"pairs.{fiat} falta", errores)
                continue
            for clave in ("code", "status", "compra", "venta", "spreadPct",
                          "mejorCompra", "mejorVenta", "muestras",
                          "promediosPorPagina", "porPlataforma"):
                if clave not in par:
                    _fallo(f"pairs.{fiat}.{clave} falta", errores)
            validar_ads(par, errores)
    if not isinstance(s.get("vesDetail"), dict):
        _fallo("vesDetail falta o no es objeto", errores)
    validar_eur_ref(s, errores)
    if (s.get("meta") or {}).get("schemaVersion") != "2":
        _fallo("meta.schemaVersion != '2'", errores)
    return errores


def main(argv=None):
    archivo = (argv or sys.argv[1:] or ["webapp/data/rates.json"])[0]
    errores = validar(archivo)
    if errores:
        print(f"FALLO ({len(errores)} errores):")
        for e in errores:
            print(f"  - {e}")
        return 1
    print(f"OK: {archivo} válido (ads + eurRef + secciones previas)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
