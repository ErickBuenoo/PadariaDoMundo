/* =========================================================
   PADARIA DO MUNDO — Autenticação & Conta (com CSRF)
   ========================================================= */

const Auth = (()=>{
  let me     = null;
  let favs   = new Set();
  let made   = {};
  let wish   = new Set();
  let devMode = false;
  let csrfToken = null;
  let forgotTimer = null;

  function getCookie(name){
    const m = document.cookie.match(new RegExp('(^|; )'+name+'=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : null;
  }

  // ---------- API helper com CSRF ----------
  async function api(path, opts={}){
    if(!csrfToken) csrfToken = getCookie('csrf_token') || '';
    const headers = {'Content-Type':'application/json','X-Requested-With':'fetch'};
    if(csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const bodyObj = opts.body && typeof opts.body !== 'string' ? opts.body : null;
    let body;
    if(bodyObj){
      body = JSON.stringify({...bodyObj, _csrf: csrfToken});
    } else if(opts.body) {
      body = opts.body;
    }
    let res = await fetch(path, {
      method: opts.method||'GET',
      credentials:'same-origin',
      headers: {...headers, ...(opts.headers||{})},
      body
    });
    let data;
    try { data = await res.json(); } catch(e){ data = {}; }
    // Se falhou CSRF, pega novo token e tenta de novo
    if(res.status === 403 && data.error && /csrf/i.test(data.error)){
      const fresh = await fetch('/api/csrf',{credentials:'same-origin'}).then(r=>r.json()).catch(()=>({csrf:''}));
      csrfToken = fresh.csrf || getCookie('csrf_token') || '';
      headers['X-CSRF-Token'] = csrfToken;
      if(bodyObj){
        body = JSON.stringify({...bodyObj, _csrf: csrfToken});
      }
      res = await fetch(path, {
        method: opts.method||'GET',
        credentials:'same-origin',
        headers:{...headers, ...(opts.headers||{})},
        body
      });
      try { data = await res.json(); } catch(e){ data = {}; }
    }
    if(!res.ok){
      const err = new Error(data.error || `Erro ${res.status}`);
      err.data = data; err.status = res.status;
      throw err;
    }
    if(data.csrf) csrfToken = data.csrf;
    return data;
  }

  // ---------- Estado ----------
  function isLoggedIn(){ return !!me; }
  function user(){ return me; }
  function isFav(id){ return favs.has(id); }
  function isMade(id){ return !!made[id]; }
  function madeData(id){ return made[id] || null; }
  function isWish(id){ return wish.has(id); }
  function stats(){ return { favs:favs.size, made:Object.keys(made).length, wish:wish.size }; }

  // ---------- Inicialização ----------
  async function init(){
    try{
      const data = await api('/api/auth/me');
      devMode = !!data.devMode;
      csrfToken = data.csrf || csrfToken;
      if(data.user){
        me = data.user;
        favs = new Set(data.favs || []);
        made = data.made || {};
        wish = new Set(data.wishlist || []);
      } else {
        me = null; favs = new Set(); made = {}; wish = new Set();
        // Migrar favoritos antigos do localStorage para o servidor após login
        const old = JSON.parse(localStorage.getItem('padaria_favs')||'[]');
        if(Array.isArray(old) && old.length){
          sessionStorage.setItem('padaria_pending_migrate', JSON.stringify(old));
        }
      }
    }catch(e){
      console.warn('Auth init failed', e);
    }
    updateUI();
    if(devMode) startDevOutbox();
    handleTokenInURL();
  }

  function updateUI(){
    const loginBtn = $('#loginBtn');
    const menu = $('#userMenu');
    const cta = $('#loginCta');
    const secFav = $('#favoritos');
    const secMade = $('#feitasesao');
    const secWish = $('#querofazer');

    if(me){
      loginBtn.classList.add('hidden');
      menu.classList.remove('hidden');
      $('#userName').textContent = me.name.split(' ')[0];
      $('#udName').textContent = me.name;
      $('#udEmail').textContent = me.email;
      const initial = (me.name[0]||'P').toUpperCase();
      $('#userAvatar').textContent = initial;
      const badge = $('#udVerifyBadge');
      const resend = $('#udResendVerify');
      if(me.email_verified){
        badge.classList.remove('hidden');
        resend.classList.add('hidden');
      } else {
        badge.classList.add('hidden');
        resend.classList.remove('hidden');
      }
      if(cta) cta.hidden = true;
      secFav.hidden = false;
      secMade.hidden = false;
      secWish.hidden = false;
    } else {
      loginBtn.classList.remove('hidden');
      menu.classList.add('hidden');
      if(cta) cta.hidden = false;
      secFav.hidden = true;
      secMade.hidden = true;
      secWish.hidden = true;
    }
    updateFavCount();
    if(typeof renderFavs === 'function') renderFavs();
    if(typeof renderUserSections === 'function') renderUserSections();
    if(typeof renderRecipes === 'function') renderRecipes();
    updateModalButtons();
  }

  function updateFavCount(){
    const badge = $('#favCount');
    if(!badge) return;
    const n = me ? favs.size : (JSON.parse(localStorage.getItem('padaria_favs')||'[]').length);
    badge.textContent = n;
    badge.classList.toggle('hidden', n===0);
  }

  function updateModalButtons(){
    if(!activeRecipe) return;
    const id = activeRecipe.id;
    const fb = $('#favBtn'), wb = $('#wishBtn'), mb = $('#madeBtn');
    if(!fb) return;
    if(me){
      fb.classList.toggle('favorited', favs.has(id));
      wb.classList.toggle('favorited', wish.has(id));
      mb.classList.toggle('favorited', !!made[id]);
      fb.title = favs.has(id) ? 'Remover dos favoritos' : 'Favoritar';
      wb.title = wish.has(id) ? 'Remover de "Quero fazer"' : 'Quero fazer';
      mb.title = made[id] ? 'Editar "Já fiz"' : 'Marcar como "Já fiz"';
    } else {
      fb.classList.remove('favorited');
      wb.classList.remove('favorited');
      mb.classList.remove('favorited');
    }
    const panel = $('#madePanel');
    if(me && made[id]){
      panel.classList.remove('hidden');
      setStars(made[id].rating||0);
      $('#madeNotes').value = made[id].notes||'';
    } else {
      panel.classList.add('hidden');
    }
  }

  function setStars(n){
    $$('#madeStars button').forEach(b=>{
      const v = parseInt(b.dataset.star);
      b.classList.toggle('on', v<=n);
    });
  }

  // ---------- Login / Registro / Logout ----------
  async function login(email, password){
    const data = await api('/api/auth/login', {method:'POST', body:{email, password}});
    csrfToken = data.csrf || csrfToken;
    await init();
    // migrar favoritos locais antigos
    const pending = JSON.parse(sessionStorage.getItem('padaria_pending_migrate')||'[]');
    if(pending.length){
      for(const rid of pending){
        if(!favs.has(rid)){
          try{ await api('/api/user/toggle-fav',{method:'POST', body:{recipe_id:rid}}); }catch(e){}
        }
      }
      sessionStorage.removeItem('padaria_pending_migrate');
      localStorage.removeItem('padaria_favs');
      await init();
    }
    return data;
  }
  async function register(name, email, password){
    return api('/api/auth/register', {method:'POST', body:{name,email,password}});
  }
  async function logout(){
    try { await api('/api/auth/logout', {method:'POST'}); }catch(e){}
    me=null; favs=new Set(); made={}; wish=new Set();
    updateUI();
    toast('Sessão encerrada. Até logo, padeiro(a)!');
  }

  function requireLogin(btn){
    if(me) return true;
    openAuth('login');
    toast('Entre ou cadastre-se para guardar suas receitas!');
    if(btn) sprinkleConfetti(btn);
    return false;
  }

  async function toggleFav(id, btn){
    if(!requireLogin(btn)) return;
    await api('/api/user/toggle-fav', {method:'POST', body:{recipe_id:id}});
    if(favs.has(id)) favs.delete(id); else favs.add(id);
    updateUI();
    return favs.has(id);
  }
  async function toggleWish(id, btn){
    if(!requireLogin(btn)) return;
    await api('/api/user/toggle-wish', {method:'POST', body:{recipe_id:id}});
    if(wish.has(id)) wish.delete(id); else wish.add(id);
    updateUI();
    return wish.has(id);
  }
  async function toggleMade(id, btn){
    if(!requireLogin(btn)) return;
    if(made[id]){ updateModalButtons(); return; }
    await api('/api/user/toggle-made', {method:'POST', body:{recipe_id:id, rating:0, notes:''}});
    made[id] = { rating:0, notes:'', made_at:Math.floor(Date.now()/1000) };
    updateUI();
    toast('Receita marcada como feita! Parabéns, padeiro(a)!');
  }
  async function saveMade(id, rating, notes){
    await api('/api/user/toggle-made', {method:'POST', body:{recipe_id:id, rating, notes}});
    made[id] = { ...(made[id]||{}), rating, notes, made_at: made[id]?.made_at || Math.floor(Date.now()/1000) };
    updateUI();
    toast('Anotações salvas no seu caderninho!');
  }

  async function forgotPassword(email){
    return api('/api/auth/forgot', {method:'POST', body:{email}});
  }
  async function resetPassword(token, password){
    return api('/api/auth/reset-password', {method:'POST', body:{token, password}});
  }
  async function verifyEmail(token){
    return api('/api/auth/verify', {method:'POST', body:{token}});
  }
  async function resendVerification(){
    await api('/api/auth/resend-verify', {method:'POST'});
    toast('E-mail de verificação reenviado!');
    if(devMode) pollDevOutbox();
  }

  function handleTokenInURL(){
    const hash = location.hash;
    let m = hash.match(/verify-email[?&]token=([^&]+)/);
    if(m){ showTokenView('verify', decodeURIComponent(m[1])); return; }
    m = hash.match(/reset-password[?&]token=([^&]+)/);
    if(m){ showTokenView('reset', decodeURIComponent(m[1])); return; }
  }

  function showTokenView(type, token){
    const tv = $('#tokenView');
    const head = $('#tokenHead');
    const body = $('#tokenBody');
    tv.classList.remove('hidden');
    if(type === 'verify'){
      head.innerHTML = `<img src="assets/bread-icon.svg" width="48" onerror="this.src='assets/bread-icon.svg'"/>
        <h2>Confirmando seu e-mail…</h2>
        <p>Só um instante, enquanto tiramos o pão do forno!</p>`;
      body.innerHTML = `<p class="auth-loading" style="text-align:center;">
        <svg width="48" height="48" class="spin-bread" viewBox="0 0 64 64">
          <ellipse cx="32" cy="38" rx="24" ry="18" fill="#E8B56A" stroke="#8B4513" stroke-width="2.5"/>
          <path d="M16 30 Q22 18 28 28 Q32 16 36 28 Q42 18 48 30" stroke="#8B4513" stroke-width="2" fill="none"/>
        </svg></p>`;
      verifyEmail(token).then(()=>{
        head.innerHTML = `<img src="assets/bread-icon.svg" width="48"/>
          <h2>E-mail confirmado!</h2>`;
        body.innerHTML = `<div class="auth-success">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#6B8E23" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          <p>Seu e-mail foi verificado! Aproveite todas as funcionalidades!</p>
          <button class="bake-btn" id="afterVerifyBtn">Continuar</button></div>`;
        setTimeout(()=>{
          const btn = $('#afterVerifyBtn');
          if(btn) btn.addEventListener('click', ()=>{
            $('#tokenView').classList.add('hidden');
            refreshMe();
          });
        }, 50);
        refreshMe();
      }).catch(e=>{
        head.innerHTML = `<h2>Ops…</h2>`;
        body.innerHTML = `<p class="auth-error">${esc(e.message)}</p>
          <button class="bake-btn" onclick="document.getElementById('tokenView').classList.add('hidden')">Fechar</button>`;
      });
    } else if(type === 'reset'){
      head.innerHTML = `<img src="assets/wheat.svg" width="48"/><h2>Crie uma nova senha</h2>
        <p>Mínimo 8 caracteres, com pelo menos uma letra e um número.</p>`;
      body.innerHTML = `<form id="resetPwForm" class="auth-form">
        <label>Nova senha
          <div class="pw-wrap">
            <input type="password" id="newPwInput" required minlength="8" autocomplete="new-password"/>
            <button type="button" class="pw-toggle" data-target="newPwInput" aria-label="Mostrar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </label>
        <button type="submit" class="bake-btn auth-submit">Redefinir senha</button>
        <p class="auth-msg" id="resetMsg"></p>
      </form>`;
      setTimeout(()=>{
        const f = $('#resetPwForm');
        if(!f) return;
        f.addEventListener('submit', async e=>{
          e.preventDefault();
          const pw = $('#newPwInput').value;
          const msg = $('#resetMsg');
          msg.style.color=''; msg.textContent='Processando…';
          try{
            await resetPassword(token, pw);
            msg.style.color='var(--leaf-dark)';
            msg.textContent='Senha redefinida! Entrando…';
            setTimeout(()=>{
              $('#tokenView').classList.add('hidden');
              openAuth('login');
            }, 1500);
          }catch(err){
            msg.style.color='var(--tomato-dark)'; msg.textContent=err.message;
          }
        });
        setupPwToggles(body);
      },50);
    }
  }

  async function refreshMe(){ await init(); }

  // ---------- Dev Outbox ----------
  function startDevOutbox(){
    $('#devOutbox').classList.remove('hidden');
    const toggle = $('#devOutboxToggle');
    const panel = $('#devOutboxPanel');
    toggle.addEventListener('click', ()=>{
      panel.classList.toggle('hidden');
      pollDevOutbox();
    });
    $('#devOutboxClear').addEventListener('click', async ()=>{
      await api('/api/dev/outbox/clear', {method:'POST'});
      renderDevOutbox([]);
    });
    pollDevOutbox();
    setInterval(pollDevOutbox, 4000);
  }
  async function pollDevOutbox(){
    try{
      const d = await api('/api/dev/outbox');
      renderDevOutbox(d.outbox||[]);
    }catch(e){}
  }
  function renderDevOutbox(items){
    $('#devOutboxCount').textContent = items.length;
    const list = $('#devOutboxList');
    if(!items.length){ list.innerHTML = '<p class="dop-empty">Nenhum e-mail ainda.</p>'; return; }
    list.innerHTML = items.slice().reverse().map(m=>{
      const links = [];
      const re = /https?:\/\/[^\s<>"']+/g;
      let lm;
      const hay = (m.text||'') + ' ' + (m.html||'');
      while((lm = re.exec(hay))){
        const u = lm[0].replace(/&amp;/g,'&');
        if(!links.includes(u)) links.push(u);
      }
      return `<div class="dop-item">
        <div class="dop-to"><strong>${esc(m.to)}</strong> · ${esc(m.subject)}</div>
        <div class="dop-links">${links.map(u=>{
          let label = 'Abrir link';
          if(u.includes('verify-email')) label='✔ Confirmar e-mail';
          else if(u.includes('reset-password')) label='🔑 Redefinir senha';
          const hash = u.includes('#') ? u.substring(u.indexOf('#')) :
                       u.includes('verify-email') ? '#/verify-email?token='+(u.split('token=')[1]||'') :
                       u.includes('reset-password') ? '#/reset-password?token='+(u.split('token=')[1]||'') : u;
          return `<a href="${esc(hash)}" class="dop-link">${label}</a>`;
        }).join('')}</div>
      </div>`;
    }).join('');
    $$('#devOutboxList a[href^="#/"]').forEach(a=>{
      a.addEventListener('click', e=>{
        e.preventDefault();
        const href = a.getAttribute('href');
        const token = href.split('token=')[1];
        if(href.includes('verify-email')) showTokenView('verify', token);
        else if(href.includes('reset-password')) showTokenView('reset', token);
      });
    });
  }

  function esc(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- Setup ----------
  function setupUI(){
    $('#loginBtn').addEventListener('click', ()=>openAuth('login'));
    $('#ctaLoginBtn').addEventListener('click', ()=>openAuth('login'));
    $('#userMenuBtn').addEventListener('click', e=>{
      e.stopPropagation();
      $('#userDropdown').classList.toggle('open');
    });
    document.addEventListener('click', e=>{
      if(!e.target.closest('#userMenu')) $('#userDropdown').classList.remove('open');
    });
    $('#logoutBtn').addEventListener('click', e=>{ e.preventDefault(); logout(); });
    $('#udResendVerify').addEventListener('click', e=>{ e.preventDefault(); resendVerification(); });

    $('#favBtn').addEventListener('click', ()=>{
      if(!activeRecipe) return;
      toggleFav(activeRecipe.id, $('#favBtn')).then(added=>{
        if(added===true) toast('Adicionado aos favoritos!');
        else if(added===false) toast('Removido dos favoritos.');
      }).catch(err=>toast(err.message));
    });
    $('#wishBtn').addEventListener('click', ()=>{
      if(!activeRecipe) return;
      toggleWish(activeRecipe.id, $('#wishBtn')).then(added=>{
        if(added===true) toast('Adicionado à lista "Quero fazer"!');
        else if(added===false) toast('Removido da lista.');
      }).catch(err=>toast(err.message));
    });
    $('#madeBtn').addEventListener('click', ()=>{
      if(!activeRecipe) return;
      if(!me){ requireLogin($('#madeBtn')); return; }
      if(!made[activeRecipe.id]) toggleMade(activeRecipe.id, $('#madeBtn'));
      else $('#madePanel').classList.toggle('hidden');
    });
    $$('#madeStars button').forEach(b=>{
      b.addEventListener('click', ()=>{
        setStars(parseInt(b.dataset.star));
      });
    });
    $('#madeSaveBtn').addEventListener('click', ()=>{
      if(!activeRecipe) return;
      const rated = $$('#madeStars button.on');
      const rating = rated.length ? parseInt(rated[rated.length-1].dataset.star) : 0;
      saveMade(activeRecipe.id, rating, $('#madeNotes').value);
      $('#madePanel').classList.add('hidden');
    });

    $('#toRegister').addEventListener('click', ()=>openAuth('register'));
    $('#toLogin').addEventListener('click', ()=>openAuth('login'));
    $('#toLoginFromForgot').addEventListener('click', ()=>openAuth('login'));
    $('#toForgot').addEventListener('click', ()=>openAuth('forgot'));
    $$('[data-auth-close]').forEach(el=>el.addEventListener('click', ()=>$('#authModal').classList.add('hidden')));
    $$('[data-token-close]').forEach(el=>el.addEventListener('click', ()=>$('#tokenView').classList.add('hidden')));

    $('#loginForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const fd = new FormData(e.target);
      const msg = $('#loginMsg'); msg.style.color=''; msg.textContent='Entrando…';
      try{
        await login(fd.get('email').trim(), fd.get('password'));
        msg.textContent='Entrou! Seja bem-vindo(a)!';
        setTimeout(()=>{
          $('#authModal').classList.add('hidden');
          e.target.reset();
        }, 500);
      }catch(err){
        msg.style.color='var(--tomato-dark)'; msg.textContent=err.message;
      }
    });
    $('#registerForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const fd = new FormData(e.target);
      const msg = $('#registerMsg'); msg.style.color=''; msg.textContent='Criando conta…';
      try{
        const name = fd.get('name').trim(), email = fd.get('email').trim(), pw = fd.get('password');
        const r = await register(name, email, pw);
        msg.style.color='var(--leaf-dark)';
        msg.innerHTML = `Conta criada! ${r.verifySent?'Enviamos um e-mail de confirmação.':''} Entrando…`;
        await init();
        setTimeout(()=>$('#authModal').classList.add('hidden'), 800);
        if(devMode) pollDevOutbox();
      }catch(err){
        msg.style.color='var(--tomato-dark)'; msg.textContent=err.message;
      }
    });
    $('#forgotForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const email = $('#forgotEmail').value.trim();
      const msg = $('#forgotMsg'); msg.style.color=''; msg.textContent='Enviando…';
      try{
        const r = await forgotPassword(email);
        msg.style.color='var(--leaf-dark)';
        msg.textContent = r.message || 'Se o e-mail existir, um link foi enviado.';
        startForgotCooldown(r.cooldown||60);
        if(devMode) pollDevOutbox();
      }catch(err){
        msg.style.color='var(--tomato-dark)'; msg.textContent=err.message;
      }
    });

    setupPwToggles(document);
  }

  function setupPwToggles(root){
    $$('.pw-toggle', root).forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const tgt = document.getElementById(btn.dataset.target);
        if(!tgt) return;
        tgt.type = tgt.type==='password' ? 'text' : 'password';
      });
    });
  }

  function startForgotCooldown(seconds){
    clearInterval(forgotTimer);
    const btn = $('#forgotSubmit');
    const cd = $('#forgotCooldown');
    let t = seconds;
    btn.disabled = true;
    cd.classList.remove('hidden');
    cd.textContent = `Aguarde ${t}s para pedir outro link…`;
    forgotTimer = setInterval(()=>{
      t--;
      if(t<=0){
        clearInterval(forgotTimer);
        btn.disabled=false;
        cd.classList.add('hidden');
      } else {
        cd.textContent = `Aguarde ${t}s para pedir outro link…`;
      }
    },1000);
  }

  function openAuth(view){
    ['authLogin','authRegister','authForgot'].forEach(id=>$('#'+id).classList.add('hidden'));
    const map = {login:'authLogin', register:'authRegister', forgot:'authForgot'};
    $(map[view]||'authLogin').classList.remove('hidden');
    $('#authModal').classList.remove('hidden');
    setTimeout(()=>{
      const inp = $(`#${map[view]} input`);
      if(inp) inp.focus();
    }, 100);
  }

  return {
    init, setupUI, isLoggedIn, user, isFav, isMade, madeData, isWish, stats,
    updateUI, updateModalButtons, updateFavCount,
    refreshMe, resendVerification, openAuth,
    favs:()=>favs, made:()=>made, wish:()=>wish
  };
})();
