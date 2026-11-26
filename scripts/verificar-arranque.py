#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verificar-arranque.py — La verdad del repo consutasas, medida en el momento.

QUE HACE
  Imprime el estado real del repositorio leyendo git:
  rama actual, HEAD, origin/main, origin/gh-pages, origin/data, origin/feat/ledger-casos,
  si la rama contiene a main, si la copia local esta al dia con origin/<rama>
  (commits por detras o sin empujar), arbol limpio (solo .pyc ignorados),
  archivos clave existentes, y un bloque "PROMPT DE RELEVO" listo para copiar
  y pegar como arranque de la siguiente sesion.

  NO escribe nada en disco ni modifica el repositorio.
  Solo biblioteca estandar de Python 3.

CODIGO DE SALIDA
  0  ok
  2  no se encontro la raiz del repo (falta .git)
"""
import subprocess
import os
import sys
import json
import datetime

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def cmd(args, cwd=None):
    """Ejecuta un comando git y devuelve (stdout, returncode)."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, cwd=cwd, timeout=30)
        return r.stdout, r.returncode
    except Exception as e:
        return str(e), 1

def head_sha():
    out, rc = cmd(['git', 'rev-parse', '--short', 'HEAD'])
    return out.strip() if rc == 0 else ''

def branch():
    out, rc = cmd(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    return out.strip() if rc == 0 else ''

def remote_url():
    out, rc = cmd(['git', 'remote', 'get-url', 'origin'])
    return out.strip() if rc == 0 else ''

def remote_sha(ref):
    out, rc = cmd(['git', 'rev-parse', '--short', ref])
    return out.strip() if rc == 0 else ''

def log_oneline(n=5):
    out, rc = cmd(['git', 'log', '--oneline', str(n)])
    return out.strip() if rc == 0 else ''

def is_tree_clean(exclude=None):
    """Verifica que git status solo muestre archivos esperados (no modificados, solo untracked/pyc)."""
    if exclude is None:
        exclude = set()
    out, _ = cmd(['git', 'status', '--short'])
    lines = [l.strip() for l in out.strip().split('\n') if l.strip()]
    for line in lines:
        code = line[:2]
        path = line[3:]
        # Modificado (M), staged (A/M/D/R), renamed (R), deleted (DU) — si hay algo modificado real, falla
        if code in (' M', 'M ', 'M ', 'MM', 'AM', 'DM', 'RM', 'AU', 'UM', 'UA'):
            if path not in exclude:
                return False, path
        # solo untracked (??) o cache modified sin trackear (M sin track)
        if code == 'M ' and path in exclude:
            continue  # OK
        if code == '??':
            if path in exclude:
                continue
        if code not in ('??',):
            if path not in exclude:
                return False, path
    return True, ''

def files_exist(paths):
    missing = []
    for p in paths:
        if not os.path.isfile(p):
            missing.append(p)
    return missing

def check_contains_upstream():
    """Verifica si la rama actual contiene a origin/main."""
    out, rc = cmd(['git', 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'])
    return rc == 0

def behind_ahead(upstream='origin/main'):
    out, rc = cmd(['git', 'rev-list', '--count', '--left-right', upstream + '..HEAD'])
    if rc != 0 or not out.strip():
        return 0, 0
    parts = out.strip().split('\t')
    try:
        return int(parts[0]), int(parts[1])
    except ValueError:
        return 0, 0

# --------------------------------------------------------------------------
# 1) Raiz del repo
# --------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.abspath(__file__))
if not os.path.isdir(os.path.join(ROOT, '..', '.git')):
    ROOT = os.getcwd()
    if not os.path.isdir(os.path.join(ROOT, '.git')):
        print('FATAL: no se encontro raiz del repo (falta .git)')
        sys.exit(2)

# --------------------------------------------------------------------------
# 2) Estado git
# --------------------------------------------------------------------------

b = branch()
h = head_sha()
rem = remote_url()
omain = remote_sha('origin/main')
ogh = remote_sha('origin/gh-pages')
odata = remote_sha('origin/data')
ofeat = remote_sha('origin/feat/ledger-casos')
has_main_ancestor = check_contains_upstream()
behind, ahead = behind_ahead('origin/main')
tree_clean, bad_path = is_tree_clean(exclude={'scripts/__pycache__/build_rates.cpython-*.pyc',
                                               'scripts/__pycache__/validate_rates.cpython-*.pyc'})
tree_ok, _ = is_tree_clean(exclude={'scripts/__pycache__/build_rates.cpython-*.pyc',
                                     'scripts/__pycache__/validate_rates.cpython-*.pyc'})

# --------------------------------------------------------------------------
# 3) Archivos clave
# --------------------------------------------------------------------------

KEY_FILES = [
    'webapp/index.html', 'webapp/assets/engine.js',
    'webapp/assets/app.js', 'webapp/assets/tasas.js',
    'webapp/assets/styles.css', 'webapp/data/rates.json',
    'webapp/dist/index.html', 'webapp/dist/data/rates.json',
    'scripts/build_rates.py', 'scripts/validate_rates.py',
    'webapp/test/engine-tests.js', 'webapp/test/ui-tests.js', 'webapp/test/tasas-tests.js',
    '.github/workflows/rates.yml',
    'scripts/verificar-arranque.py',
]
missing = files_exist(KEY_FILES)

# --------------------------------------------------------------------------
# 4) rates.json frescura
# --------------------------------------------------------------------------

rates_fresh = None
rates_path = os.path.join(ROOT, '..', 'webapp', 'data', 'rates.json')
if os.path.isfile(rates_path):
    try:
        with open(rates_path) as f:
            j = json.load(f)
        ga = j.get('generatedAt', '')
        now = datetime.datetime.now(datetime.timezone.utc)
        if ga:
            try:
                from dateutil.parser import isoparse as parse_dt
                gdt = parse_dt(ga)
                age_min = (now - gdt).total_seconds() / 60
                rates_fresh = {'generatedAt': ga, 'age_minutes': round(age_min, 0)}
            except Exception:
                rates_fresh = {'generatedAt': ga, 'parse_error': True}
        else:
            rates_fresh = {'generatedAt': 'ausente'}
    except Exception:
        rates_fresh = {'read_error': True}

# --------------------------------------------------------------------------
# 5) PR/fechas de gh-pages
# --------------------------------------------------------------------------

gh_last_commit_sha = remote_sha('origin/gh-pages')
gh_last_msg, _ = cmd(['git', 'log', '--oneline', '-1', 'origin/gh-pages'])

# --------------------------------------------------------------------------
# SALIDA
# --------------------------------------------------------------------------

now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

print('=' * 70)
print('VERIFICACION DE ARRANQUE — consutasas')
print('Fecha:', now)
print('=' * 70)

print(f'\nRAMA:    {b}')
print(f'HEAD:    {h}')
print(f'REMOTO:  {rem}')
print(f'origin/main:         {omain}')
print(f'origin/gh-pages:     {ogh}')
print(f'origin/data:         {odata}')
print(f'origin/feat/ledger:  {ofeat}')
print(f'contiene origin/main: {has_main_ancestor}')
print(f'commits detras main: {behind}  adelante: {ahead}')
print(f'arbol limpio: {tree_ok} {"(solo .pyc ignorados)" if tree_ok else ""}')
if not tree_ok:
    print(f'  arbol sucio en: {bad_path}')

print(f'\nARCHIVOS FALTANTES: {missing if missing else "ninguno"}')

if rates_fresh:
    print(f'\nrates.json: {json.dumps(rates_fresh)}')

print(f'\nÚLTIMO COMMIT gh-pages: {gh_last_msg.strip()}')

# --------------------------------------------------------------------------
# PROMPT DE RELEVO
# --------------------------------------------------------------------------

print('\n' + '=' * 70)
print('PROMPT DE RELEVO')
print('=' * 70)
print(f'''REPO: /home/avelis/consutasas | rama: {b} | HEAD: {h} | remoto: {rem}
origin/main: {omain} | origin/gh-pages: {ogh} | origin/data: {odata} | origin/feat/ledger-casos: {ofeat}
rama contiene origin/main: {has_main_ancestor} | detras main: {behind} | adelante: {ahead}
arbol limpio: {tree_ok}

ARCHIVOS CLAVE EXISTEN: {"" if not missing else "FALTANTES: " + ", ".join(missing)}

rates.json: {json.dumps(rates_fresh) if rates_fresh else "no encontrado"}

ÚLTIMO COMMIT gh-pages: {gh_last_msg.strip()}

PRONTO DE ARRANQUE para la proxima sesion:
1. ejecutar: python3 scripts/verificar-arranque.py
2. si el resultado NO es 0, reparar solo los FAILs antes de trabajar.
3. Revisar el historico de commits y decidir donde continuar (no hay tareas/ ni ESTADO.md).
4. Si verificar-arranque da FALLA, reportar y reparar SOLO ese fallo.
AVISO no bloquea — seguir trabajando.''')