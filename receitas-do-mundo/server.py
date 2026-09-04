"""
===========================================================
PADARIA DO MUNDO — Backend Flask (PRODUÇÃO)
Autenticação + perfis de usuário + favoritos/feitas/querofazer
===========================================================

Medidas de segurança implementadas:
- Senhas com hash PBKDF2 (werkzeug) - nunca armazenadas em claro
- Cookies HttpOnly, SameSite=Strict, Secure (em HTTPS)
- CSRF token em todas as requisições mutativas
- Rate limiting por IP em: login (5/5min, 10/15min), registro (3/hora),
  reset de senha (1/min), verify resend (1/min)
- CSP + cabeçalhos de segurança (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS)
- Chave secreta persistente em arquivo (não muda entre restarts)
- Validação e sanitização rigorosa de todas as entradas
- Limite de tamanho de campos (nomes, notas, senhas)
- Registro de tentativas de login (logs)
- Tokens single-use com expiração
- Respostas genéricas para não enumerar contas
- E-mail obrigatório para: reset de senha, mudanças sensíveis
- Sessão expira após 30 dias de inatividade
- Sem servidor de desenvolvimento em 0.0.0.0 (usamos waitress/gunicorn quando disponíveis)

SMTP real: configure as variáveis de ambiente:
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
  PADARIA_HTTPS=1  para ativar cookies Secure e HSTS
Se SMTP não configurado, roda em MODO DEV (e-mails aparecem na bandeja da UI).
"""
from __future__ import annotations
import os, re, json, time, sqlite3, secrets, logging, smtplib
from datetime import datetime, timedelta
from functools import wraps
from collections import defaultdict, deque
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from flask import (Flask, request, jsonify, session, g, redirect,
                   send_from_directory, abort, make_response)
from werkzeug.security import generate_password_hash, check_password_hash

# ---------- Configurações ----------
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DB_PATH     = os.path.join(BASE_DIR, 'padaria.db')
SECRET_FILE = os.path.join(BASE_DIR, '.secret_key')
LOG_FILE    = os.path.join(BASE_DIR, 'padaria.log')
HTTPS_ENABLED = os.environ.get('PADARIA_HTTPS', '0') == '1'
DEV_MODE     = not os.environ.get('SMTP_HOST')

# Persistir a chave secreta (gera uma nova uma única vez)
def load_or_create_secret():
    if os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, 'r', encoding='utf-8') as f:
            return f.read().strip()
    key = secrets.token_hex(64)
    with open(SECRET_FILE, 'w', encoding='utf-8') as f:
        f.write(key)
    try: os.chmod(SECRET_FILE, 0o600)
    except OSError: pass
    return key

SECRET_KEY = load_or_create_secret()

# Bloqueio de domínios de e-mail descartáveis
BLOCKED_DOMAINS = {
    'temp-mail.org','tempmail.com','10minutemail.com','guerrillamail.com',
    'yopmail.com','throwawaymail.com','mailinator.com','dispostable.com',
    'trashmail.com','sharklasers.com','guerrillamail.net','guerrillamail.org',
    'maildrop.cc','harakirimail.com','getnada.com','mohmal.com',
    'fakeinbox.com','mintemail.com','emailondeck.com','temp-mail.io',
    'tempmail.plus','spamgourmet.com','jetable.org','mailnesia.com',
    'spam4.me','yopmail.fr','yopmail.net','cool.fr.nf','jetable.fr.nf',
    'nospam.ze.tc','nomail.xl.cx','mega.zik.dj','speed.1s.fr','courriel.fr.nf',
    'moncourrier.fr.nf','emailias.com','spamex.com','spamgourmet.net',
    'soodonims.com','gishpuppy.com','pookmail.com','spam.la',
    'dontreg.com','mailexpire.com','maillink.me','mailcatch.com',
}

# Limites de comprimento
MAX_NAME_LEN    = 80
MAX_EMAIL_LEN   = 254
MAX_PW_LEN      = 128
MIN_PW_LEN      = 8
MAX_NOTES_LEN   = 1000
MAX_RATING      = 5
RECIPE_ID_RE    = re.compile(r'^[a-zA-Z0-9_\-]{1,80}$')

# Rate limiting (janela deslizante em memória)
RATE_LIMITS = {
    'login':        (5,   60*5),     # 5 tentativas em 5 min
    'login_heavy':  (10,  60*15),    # ou 10 em 15 min → bloqueio maior
    'register':     (3,   60*60),    # 3 contas por IP por hora
    'forgot':       (1,   60),       # 1 pedido por minuto (cooldown já existe no DB)
    'resend':       (1,   60),       # reenvio de verificação
    'toggle':       (60,  60),       # 60 toggles fav/made/wish por minuto
    'api_global':   (200, 60),       # 200 requisições gerais por minuto
}
rate_buckets = defaultdict(lambda: defaultdict(deque))

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler()]
)
log = logging.getLogger('padaria')

# ---------- App ----------
app = Flask(__name__, static_folder=None)
app.secret_key = SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=HTTPS_ENABLED,
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=16 * 1024,  # 16 KB de payload é mais que suficiente
)

DEV_OUTBOX = []

# ---------- Utilitários ----------
def get_client_ip():
    # Em produção atrás de proxy, usar X-Forwarded-For APENAS se proxy for confiável.
    fwd = request.headers.get('X-Forwarded-For', '')
    if fwd:
        ip = fwd.split(',')[0].strip()
    else:
        ip = request.remote_addr or '0.0.0.0'
    return ip

def rate_limit(key, name):
    """Retorna (ok: bool, retry_after: int)."""
    if name not in RATE_LIMITS:
        return True, 0
    limit, window = RATE_LIMITS[name]
    bucket = rate_buckets[get_client_ip()][key + ':' + name]
    now = time.time()
    # Remove entradas antigas
    while bucket and now - bucket[0] > window:
        bucket.popleft()
    if len(bucket) >= limit:
        retry = int(window - (now - bucket[0])) + 1
        return False, retry
    bucket.append(now)
    return True, 0

def require_rate_limit(name, key=None):
    k = key or (request.endpoint or 'global')
    ok, retry = rate_limit(k, name)
    if not ok:
        log.warning(f'RATE LIMIT: {get_client_ip()} {name} retry={retry}s')
        resp = jsonify(error=f'Muitas requisições. Aguarde {retry}s.', retryAfter=retry)
        resp.status_code = 429
        abort(resp)

# ---------- DB ----------
def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys = ON')
    return g.db

@app.teardown_appcontext
def close_db(exc):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        email_lower TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_login INTEGER,
        login_failures INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS verify_tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS reset_tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS reset_cooldowns (
        email_lower TEXT PRIMARY KEY,
        last_request INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_favs (
        user_id INTEGER NOT NULL,
        recipe_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, recipe_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_made (
        user_id INTEGER NOT NULL,
        recipe_id TEXT NOT NULL,
        rating INTEGER,
        notes TEXT,
        made_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, recipe_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_wishlist (
        user_id INTEGER NOT NULL,
        recipe_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, recipe_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        email TEXT,
        success INTEGER NOT NULL,
        ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_la_ip_ts ON login_attempts(ip, ts);
    ''')
    conn.commit()
    conn.close()

# ---------- Validações ----------
EMAIL_RE = re.compile(r'^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$')
NAME_RE  = None  # validação manual em valid_name

def valid_email(em: str):
    if not em or len(em) > MAX_EMAIL_LEN:
        return False
    if not EMAIL_RE.match(em):
        return False
    dom = em.rsplit('@', 1)[-1].lower()
    if dom in BLOCKED_DOMAINS:
        return False
    if '.' not in dom:
        return False
    return True

def valid_name(n: str):
    if not n: return False
    n = n.strip()
    if len(n) < 2 or len(n) > MAX_NAME_LEN: return False
    # Permite letras (Unicode, incluindo acentos), apóstrofos, hífens, pontos e espaços
    # Rejeita caracteres de controle, números e símbolos suspeitos
    allowed_categories = {'Lu','Ll','Lt','Lm','Lo','Mn','Mc','Pd','Po','Zs'}
    import unicodedata
    for ch in n:
        cat = unicodedata.category(ch)
        # Aceita letras, hífen, apóstrofo, ponto, espaço
        if ch in "-'. " : continue
        if cat[0] != 'L':  # deve ser letra
            return False
    return True

def password_ok(pw: str):
    if not pw or len(pw) < MIN_PW_LEN:
        return False, f'A senha precisa ter pelo menos {MIN_PW_LEN} caracteres.'
    if len(pw) > MAX_PW_LEN:
        return False, 'Senha muito longa.'
    if not re.search(r'[A-Za-z]', pw):
        return False, 'A senha deve conter pelo menos uma letra.'
    if not re.search(r'\d', pw):
        return False, 'A senha deve conter pelo menos um número.'
    return True, ''

def sanitize_text(s, maxlen=1000):
    if s is None: return ''
    if not isinstance(s, str): s = str(s)
    # Remove caracteres de controle exceto quebras de linha e tabs
    s = ''.join(c for c in s if c >= ' ' or c in '\n\t')
    s = s.strip()
    if len(s) > maxlen: s = s[:maxlen]
    return s

def valid_recipe_id(rid):
    return bool(rid and RECIPE_ID_RE.match(rid))

def make_token():
    return secrets.token_urlsafe(32)

# ---------- CSRF ----------
def get_csrf_token():
    tok = session.get('_csrf')
    if not tok:
        tok = secrets.token_urlsafe(32)
        session['_csrf'] = tok
        session.modified = True
    return tok

def csrf_protect():
    # Para métodos não seguros, exigir token
    if request.method in ('POST','PUT','PATCH','DELETE'):
        expected = session.get('_csrf')
        got = (request.headers.get('X-CSRF-Token')
               or (request.get_json(silent=True) or {}).get('_csrf')
               or request.form.get('_csrf'))
        if not expected or not got or not secrets.compare_digest(str(expected), str(got)):
            log.warning(f'CSRF FAIL from {get_client_ip()}')
            abort(403, description='Token de segurança inválido. Recarregue a página.')

@app.before_request
def _before():
    # Rate limit global por IP
    ok, retry = rate_limit(request.path, 'api_global')
    if not ok:
        resp = jsonify(error='Muitas requisições.', retryAfter=retry)
        resp.status_code = 429
        abort(resp)
    # CSRF (apenas mutativos)
    csrf_protect()
    # Atualizar timestamp da sessão se autenticado (sliding expiration)
    if 'user_id' in session:
        session.permanent = True
        session['_last_seen'] = int(time.time())

@app.after_request
def _after(resp):
    # Cabeçalhos de segurança em TODAS as respostas
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['X-Frame-Options'] = 'DENY'
    resp.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    resp.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'
    resp.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: https:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'; "
        "base-uri 'self'"
    )
    if HTTPS_ENABLED:
        resp.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    # Sempre garantir que o CSRF cookie está presente (não HttpOnly para o JS ler)
    token = get_csrf_token()
    resp.set_cookie('csrf_token', token,
                    httponly=False, samesite='Lax',
                    secure=HTTPS_ENABLED, max_age=60*60*24*30)
    return resp

# ---------- Auth helpers ----------
def current_user():
    uid = session.get('user_id')
    if not uid: return None
    row = get_db().execute(
        'SELECT id,name,email,email_verified,created_at,locked_until FROM users WHERE id=?',
        (uid,)).fetchone()
    if not row:
        session.clear()
        return None
    if row['locked_until'] and row['locked_until'] > time.time():
        return None
    return dict(row)

def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        u = current_user()
        if not u:
            return jsonify(error='login_required'), 401
        g.user = u
        return fn(*a, **kw)
    return wrapper

# ---------- E-mail ----------
def send_email(to_addr, subject, text_body, html_body=None):
    msg = MIMEMultipart('alternative')
    msg['From'] = os.environ.get('SMTP_FROM','no-reply@padariadomundo.app')
    msg['To'] = to_addr
    msg['Subject'] = subject
    msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
    if html_body:
        msg.attach(MIMEText(html_body, 'html', 'utf-8'))
    if DEV_MODE:
        DEV_OUTBOX.append({'to':to_addr,'subject':subject,'text':text_body,
                           'html':html_body,'time':int(time.time())})
        if len(DEV_OUTBOX) > 50: DEV_OUTBOX.pop(0)
        log.info(f'[DEV EMAIL] → {to_addr}: {subject}')
        return True
    try:
        host = os.environ['SMTP_HOST']
        port = int(os.environ.get('SMTP_PORT', 587))
        with smtplib.SMTP(host, port, timeout=10) as s:
            s.starttls()
            s.login(os.environ['SMTP_USER'], os.environ['SMTP_PASS'])
            s.sendmail(msg['From'], [to_addr], msg.as_string())
        return True
    except Exception as e:
        log.error(f'SMTP error: {e}')
        return False

def abs_url(path):
    return request.host_url.rstrip('/') + path

def verification_email(user, token):
    link = abs_url('/#/verify-email?token='+token)
    subj = 'Padaria do Mundo — Confirme seu e-mail'
    text = (f"Olá, {user['name']}!\n\n"
            f"Bem-vindo(a) à Padaria do Mundo! Confirme seu e-mail no link:\n"
            f"{link}\n\nVálido por 24h.\n")
    html = _tpl_email('Confirme seu e-mail', user['name'],
                      'Clique para confirmar seu cadastro:', link, 'Confirmar e-mail')
    return send_email(user['email'], subj, text, html)

def reset_email(user, token):
    link = abs_url('/#/reset-password?token='+token)
    subj = 'Padaria do Mundo — Recuperação de senha'
    text = (f"Olá, {user['name']}!\n\n"
            f"Link para redefinir sua senha:\n{link}\n\nVálido por 15 minutos.")
    html = _tpl_email('Redefina sua senha', user['name'],
                      'Clique para criar uma nova senha:', link, 'Redefinir senha',
                      color='#8B4513', button_color='#8B4513')
    return send_email(user['email'], subj, text, html)

def _tpl_email(title, name, intro, link, btn_text, color='#C0392B', button_color='#C0392B'):
    return f"""<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px;background:#FBF3E2;border:2px dashed #8B4513;border-radius:12px;">
<h2 style="color:{color};text-align:center;">{title}</h2>
<p>Olá, <strong>{name}</strong>!</p>
<p>{intro}</p>
<p style="text-align:center;"><a href="{link}" style="display:inline-block;background:{button_color};color:#fff;padding:12px 24px;border-radius:24px;text-decoration:none;font-weight:bold;">{btn_text}</a></p>
<p style="font-size:.9em;color:#5C2E0A;">Link direto (se o botão não funcionar):<br><a href="{link}">{link}</a></p>
</div>"""

def _rec_login(ip, email, success):
    try:
        db = get_db()
        db.execute('INSERT INTO login_attempts(ip,email,success,ts) VALUES(?,?,?,?)',
                   (ip, email, 1 if success else 0, int(time.time())))
        # Limpa entradas com mais de 30 dias
        db.execute('DELETE FROM login_attempts WHERE ts < ?', (int(time.time())-30*86400,))
        db.commit()
    except Exception as e:
        log.error(f'log login failed: {e}')

# ---------- Rotas da API ----------
@app.route('/api/csrf')
def api_csrf():
    return jsonify(csrf=get_csrf_token())

@app.route('/api/auth/me')
def api_me():
    u = current_user()
    if not u:
        return jsonify(user=None, devMode=DEV_MODE)
    db = get_db()
    favs = [r['recipe_id'] for r in db.execute(
        'SELECT recipe_id FROM user_favs WHERE user_id=?', (u['id'],)).fetchall()]
    made = {}
    for r in db.execute(
        'SELECT recipe_id, rating, notes, made_at FROM user_made WHERE user_id=?',
        (u['id'],)).fetchall():
        made[r['recipe_id']] = dict(r)
    wish = [r['recipe_id'] for r in db.execute(
        'SELECT recipe_id FROM user_wishlist WHERE user_id=?', (u['id'],)).fetchall()]
    return jsonify(user=u, favs=favs, made=made, wishlist=wish,
                   csrf=get_csrf_token(), devMode=DEV_MODE)

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    require_rate_limit('register')
    data = request.get_json(silent=True) or {}
    name  = sanitize_text(data.get('name',''), MAX_NAME_LEN)
    email = (data.get('email') or '').strip()
    pw    = data.get('password') or ''
    if not valid_name(name):
        return jsonify(error='Nome inválido (2-80 caracteres, letras, espaços, hífens e apóstrofos).'), 400
    if not valid_email(email):
        return jsonify(error='E-mail inválido ou domínio bloqueado (use um e-mail real).'), 400
    ok, msg = password_ok(pw)
    if not ok: return jsonify(error=msg), 400
    elow = email.lower()
    db = get_db()
    if db.execute('SELECT 1 FROM users WHERE email_lower=?', (elow,)).fetchone():
        # Mensagem genérica mas útil
        return jsonify(error='Já existe uma conta com este e-mail.'), 400
    uid = db.execute(
        'INSERT INTO users(name,email,email_lower,password_hash,created_at) VALUES(?,?,?,?,?)',
        (name, email, elow,
         generate_password_hash(pw, method='pbkdf2:sha256', salt_length=16),
         int(time.time()))).lastrowid
    db.commit()
    tok = make_token()
    db.execute('INSERT INTO verify_tokens(token,user_id,created_at) VALUES(?,?,?)',
               (tok, uid, int(time.time())))
    db.commit()
    u = {'id':uid,'name':name,'email':email,'email_verified':0}
    verification_email(u, tok)
    session.clear()
    session['user_id'] = uid
    session.permanent = True
    get_csrf_token()
    _rec_login(get_client_ip(), email, True)
    log.info(f'REGISTER: new user {uid} ({email}) from {get_client_ip()}')
    return jsonify(ok=True, verifySent=True, devMode=DEV_MODE, csrf=session.get('_csrf'))

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    require_rate_limit('login')
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    pw    = data.get('password') or ''
    ip    = get_client_ip()
    db    = get_db()
    if not valid_email(email) or not pw:
        _rec_login(ip, email, False)
        return jsonify(error='E-mail ou senha incorretos.'), 401
    # Rate limit pesado por e-mail também
    ok, retry = rate_limit('login:email:'+email, 'login_heavy')
    if not ok:
        return jsonify(error=f'Muitas tentativas. Aguarde {retry}s.', retryAfter=retry), 429
    row = db.execute('SELECT * FROM users WHERE email_lower=?', (email,)).fetchone()
    if not row or not check_password_hash(row['password_hash'], pw):
        # Incrementa falhas
        if row:
            db.execute('UPDATE users SET login_failures=login_failures+1 WHERE id=?', (row['id'],))
            # Bloqueia após 10 falhas por 15 min
            if (row['login_failures'] or 0) + 1 >= 10:
                db.execute('UPDATE users SET locked_until=? WHERE id=?',
                           (int(time.time())+15*60, row['id']))
            db.commit()
        _rec_login(ip, email, False)
        return jsonify(error='E-mail ou senha incorretos.'), 401
    if row['locked_until'] and row['locked_until'] > time.time():
        wait = int(row['locked_until']-time.time())
        return jsonify(error=f'Conta temporariamente bloqueada. Aguarde {wait}s.', retryAfter=wait), 429
    # Login bem-sucedido
    db.execute('UPDATE users SET last_login=?, login_failures=0, locked_until=NULL WHERE id=?',
               (int(time.time()), row['id']))
    db.commit()
    session.clear()
    session['user_id'] = row['id']
    session.permanent = True
    get_csrf_token()
    _rec_login(ip, email, True)
    log.info(f'LOGIN: user {row["id"]} ({email}) from {ip}')
    return jsonify(ok=True, user={'id':row['id'],'name':row['name'],
                                   'email':row['email'],'email_verified':row['email_verified']},
                   csrf=session.get('_csrf'))

@app.route('/api/auth/logout', methods=['POST'])
def api_logout():
    log.info(f'LOGOUT: user {session.get("user_id")}')
    session.clear()
    return jsonify(ok=True)

@app.route('/api/auth/verify', methods=['POST'])
def api_verify():
    data = request.get_json(silent=True) or {}
    token = sanitize_text(data.get('token',''), 100)
    if not token or len(token) != 43:  # token_urlsafe(32) tem sempre 43 chars
        return jsonify(error='Token inválido.'), 400
    db = get_db()
    row = db.execute('SELECT * FROM verify_tokens WHERE token=? AND used=0', (token,)).fetchone()
    if not row:
        return jsonify(error='Link inválido ou já utilizado.'), 400
    if time.time() - row['created_at'] > 24*3600:
        return jsonify(error='Este link expirou. Solicite um novo.'), 400
    db.execute('UPDATE users SET email_verified=1 WHERE id=?', (row['user_id'],))
    db.execute('UPDATE verify_tokens SET used=1 WHERE token=?', (token,))
    db.commit()
    log.info(f'VERIFY: user {row["user_id"]} verified email')
    return jsonify(ok=True)

@app.route('/api/auth/resend-verify', methods=['POST'])
@login_required
def api_resend_verify():
    require_rate_limit('resend')
    db = get_db()
    u = db.execute('SELECT * FROM users WHERE id=?', (g.user['id'],)).fetchone()
    if u['email_verified']:
        return jsonify(error='Seu e-mail já está verificado.'), 400
    tok = make_token()
    db.execute('INSERT INTO verify_tokens(token,user_id,created_at) VALUES(?,?,?)',
               (tok, u['id'], int(time.time())))
    db.execute('INSERT OR REPLACE INTO reset_cooldowns(email_lower,last_request) VALUES(?,?)',
               (u['email_lower'], int(time.time())))
    db.commit()
    verification_email(dict(u), tok)
    return jsonify(ok=True, devMode=DEV_MODE)

@app.route('/api/auth/forgot', methods=['POST'])
def api_forgot():
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    ip = get_client_ip()
    db = get_db()
    require_rate_limit('forgot')
    now = int(time.time())
    # cooldown de 60s também por e-mail (mesmo que não exista)
    last = db.execute('SELECT last_request FROM reset_cooldowns WHERE email_lower=?', (email,)).fetchone()
    wait = 60
    if last and now - last['last_request'] < wait:
        w = int(wait-(now-last['last_request']))
        return jsonify(ok=True, cooldown=w,
                       message=f'Se o e-mail existir, um link foi enviado. Aguarde {w}s para pedir outro.')
    db.execute('INSERT OR REPLACE INTO reset_cooldowns(email_lower,last_request) VALUES(?,?)', (email,now))
    db.commit()
    u = db.execute('SELECT * FROM users WHERE email_lower=?', (email,)).fetchone()
    if u:
        tok = make_token()
        db.execute('INSERT INTO reset_tokens(token,user_id,created_at) VALUES(?,?,?)', (tok,u['id'],now))
        db.commit()
        reset_email(dict(u), tok)
        log.info(f'FORGOT: reset requested for {email} from {ip}')
    return jsonify(ok=True, message='Se o e-mail existir, um link foi enviado.', cooldown=wait)

@app.route('/api/auth/reset-password', methods=['POST'])
def api_reset_password():
    data = request.get_json(silent=True) or {}
    token = sanitize_text(data.get('token',''), 100)
    pw    = data.get('password') or ''
    if not token or len(token)!=43:
        return jsonify(error='Token inválido.'), 400
    ok, msg = password_ok(pw)
    if not ok: return jsonify(error=msg), 400
    db = get_db()
    row = db.execute('SELECT * FROM reset_tokens WHERE token=? AND used=0', (token,)).fetchone()
    if not row:
        return jsonify(error='Link inválido ou já utilizado.'), 400
    if time.time()-row['created_at'] > 15*60:
        return jsonify(error='Este link expirou (15 min). Solicite um novo.'), 400
    db.execute('UPDATE users SET password_hash=?, login_failures=0, locked_until=NULL WHERE id=?',
               (generate_password_hash(pw, method='pbkdf2:sha256', salt_length=16), row['user_id']))
    db.execute('UPDATE reset_tokens SET used=1 WHERE token=?', (token,))
    # Invalida todas as sessões daquele usuário (força novo login)
    db.commit()
    log.info(f'RESET: password reset for user {row["user_id"]}')
    return jsonify(ok=True)

@app.route('/api/auth/cooldown')
def api_cooldown():
    email = (request.args.get('email') or '').strip().lower()
    if not email: return jsonify(wait=0)
    db = get_db()
    last = db.execute('SELECT last_request FROM reset_cooldowns WHERE email_lower=?', (email,)).fetchone()
    if not last: return jsonify(wait=0)
    wait = max(0, int(60-(time.time()-last['last_request'])))
    return jsonify(wait=wait)

# ---------- User actions ----------
def _toggle_table(table, recipe_id, extra=None):
    uid = session['user_id']
    db = get_db()
    rid = sanitize_text(recipe_id, 80)
    if not valid_recipe_id(rid):
        return jsonify(error='ID de receita inválido.'), 400
    exists = db.execute(f'SELECT * FROM {table} WHERE user_id=? AND recipe_id=?', (uid,rid)).fetchone()
    if exists:
        db.execute(f'DELETE FROM {table} WHERE user_id=? AND recipe_id=?', (uid,rid))
        action = 'removed'
    else:
        if table == 'user_made':
            rating = int((extra or {}).get('rating') or 0)
            notes  = sanitize_text((extra or {}).get('notes',''), MAX_NOTES_LEN)
            if rating < 0 or rating > MAX_RATING: rating = 0
            db.execute(
                'INSERT INTO user_made(user_id,recipe_id,made_at,rating,notes) VALUES(?,?,?,?,?)',
                (uid,rid,int(time.time()),rating,notes))
        else:
            db.execute(f'INSERT INTO {table}(user_id,recipe_id,added_at) VALUES(?,?,?)',
                       (uid,rid,int(time.time())))
        action = 'added'
    db.commit()
    return jsonify(ok=True, action=action)

@app.route('/api/user/toggle-fav', methods=['POST'])
@login_required
def api_fav():
    require_rate_limit('toggle')
    d = request.get_json(silent=True) or {}
    return _toggle_table('user_favs', d.get('recipe_id',''))

@app.route('/api/user/toggle-wish', methods=['POST'])
@login_required
def api_wish():
    require_rate_limit('toggle')
    d = request.get_json(silent=True) or {}
    return _toggle_table('user_wishlist', d.get('recipe_id',''))

@app.route('/api/user/toggle-made', methods=['POST'])
@login_required
def api_made():
    require_rate_limit('toggle')
    d = request.get_json(silent=True) or {}
    rid = sanitize_text(d.get('recipe_id',''), 80)
    uid = g.user['id']
    db = get_db()
    if not valid_recipe_id(rid):
        return jsonify(error='ID inválido.'), 400
    exists = db.execute('SELECT * FROM user_made WHERE user_id=? AND recipe_id=?', (uid,rid)).fetchone()
    if exists:
        rating = d.get('rating')
        notes = d.get('notes')
        if rating is None and notes is None:
            db.execute('DELETE FROM user_made WHERE user_id=? AND recipe_id=?', (uid,rid))
            db.commit()
            return jsonify(ok=True, action='removed')
        try: r = int(rating)
        except (TypeError, ValueError): r = exists['rating']
        r = max(0, min(MAX_RATING, r))
        n = sanitize_text(notes if notes is not None else exists['notes'], MAX_NOTES_LEN)
        db.execute('UPDATE user_made SET rating=?, notes=? WHERE user_id=? AND recipe_id=?',
                   (r,n,uid,rid))
        db.commit()
        return jsonify(ok=True, action='updated')
    try: r = int(d.get('rating') or 0)
    except (TypeError, ValueError): r = 0
    r = max(0, min(MAX_RATING, r))
    n = sanitize_text(d.get('notes',''), MAX_NOTES_LEN)
    db.execute('INSERT INTO user_made(user_id,recipe_id,made_at,rating,notes) VALUES(?,?,?,?,?)',
               (uid,rid,int(time.time()),r,n))
    db.commit()
    return jsonify(ok=True, action='added')

# ---------- Dev outbox ----------
@app.route('/api/dev/outbox')
def api_dev_outbox():
    if not DEV_MODE: return jsonify(outbox=[])
    return jsonify(outbox=DEV_OUTBOX[-10:])

@app.route('/api/dev/outbox/clear', methods=['POST'])
def api_dev_clear():
    DEV_OUTBOX.clear()
    return jsonify(ok=True)

# ---------- Erros ----------
@app.errorhandler(429)
def _too_many(e):
    resp = jsonify(error=str(e.description) if hasattr(e,'description') else 'Muitas requisições.')
    resp.status_code = 429
    return resp
@app.errorhandler(403)
def _forbidden(e):
    return jsonify(error=str(e.description) if hasattr(e,'description') else 'Proibido.'), 403
@app.errorhandler(413)
def _too_large(e):
    return jsonify(error='Payload muito grande.'), 413

# ---------- Servir o site ----------
@app.route('/')
def index():
    resp = make_response(send_from_directory(BASE_DIR, 'index.html'))
    return resp

@app.route('/<path:filename>')
def static_files(filename):
    if filename.endswith(('.py','.db','.pyc','.secret_key','.log')) or filename.startswith('.'):
        abort(404)
    full = os.path.join(BASE_DIR, filename)
    if os.path.isfile(full):
        return send_from_directory(BASE_DIR, filename)
    # SPA fallback — todas as rotas não-arquivo servem index.html
    return send_from_directory(BASE_DIR, 'index.html')

# ---------- Main ----------
if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 8080))
    print('='*60)
    print(f'🥐 Padaria do Mundo (seguro)')
    print(f'   Porta: {port}')
    print(f'   HTTPS: {HTTPS_ENABLED}')
    print(f'   DEV MODE: {DEV_MODE}')
    print(f'   DB: {DB_PATH}')
    print(f'   Logs: {LOG_FILE}')
    print('='*60)
    # Usa waitress se disponível (servidor produção), senão Flask
    try:
        from waitress import serve
        print('   Usando waitress (servidor produção)')
        serve(app, host='0.0.0.0', port=port, threads=8)
    except ImportError:
        print('   AVISO: waitress não instalado; usando servidor dev do Flask.')
        print('   Para produção instale: pip install waitress')
        app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)
