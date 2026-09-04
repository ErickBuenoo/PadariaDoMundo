/* =========================================================
   PADARIA DO MUNDO — App.js
   Lazy loading + favoritos + modo cozinha + filtros + surpresa
   ========================================================= */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Estado ----------
let currentFilter     = 'all';
let currentCategory   = null;
let searchTerm        = '';
let filterTime        = 'all';     // 'all' | 'fast'
let filterDiff        = 'all';     // 'all' | 'easy' | 'medium' | 'hard'
let activeRecipe      = null;
let cookModeOn        = false;
let wakeLock          = null;
const recipeCache     = {};
let favorites         = []; // para visitantes: localStorage; logados: servidor via Auth
let isLoading         = false;

// Helpers para favoritos (funciona tanto p/ visitantes quanto logados)
function favs(){
  if(window.Auth && Auth.isLoggedIn()) return [...Auth.favs()];
  return favorites;
}
function isFav(id){
  return favs().includes(id);
}
function addFavLocal(id){
  const i = favorites.indexOf(id);
  if(i<0) favorites.push(id);
  localStorage.setItem('padaria_favs', JSON.stringify(favorites));
}
function removeFavLocal(id){
  favorites = favorites.filter(x=>x!==id);
  localStorage.setItem('padaria_favs', JSON.stringify(favorites));
}

// ---------- Helpers ----------
const html = (strs, ...vals) =>
  strs.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), '');

function countBy(arr, key){
  return arr.reduce((m, r)=>((m[r[key]]=(m[r[key]]||0)+1),m), {});
}

function svgIcon(id, cls='', size=20){
  return `<svg class="${cls}" width="${size}" height="${size}" aria-hidden="true"><use href="assets/icons.svg#${id}"/></svg>`;
}

const META_ICONS = {
  time: 'i-clock',
  servings: 'i-people',
  difficulty: 'i-fire',
  category: 'i-plate'
};

const CAT_ICONS = {
  paes:'i-bread', doces:'i-cupcake', salgados:'i-dumpling',
  massas:'i-pasta', pratos:'i-curry', sopas:'i-soup',
  bebidas:'i-coffee', cafemanha:'i-pancake'
};

function catName(id){
  const c = CATEGORIES.find(x=>x.id===id);
  return c ? c.nome.replace(/&amp;/g,'&') : id;
}

const DIFF_MAP = {
  'Fácil':'easy','Média':'medium','Difícil':'hard'
};

function parseTime(tempo){
  // retorna minutos
  const t = tempo.toLowerCase();
  let min = 0;
  const h = t.match(/(\d+)\s*h/);
  const m = t.match(/(\d+)\s*min/);
  if(h) min += parseInt(h[1])*60;
  if(m) min += parseInt(m[1]);
  if(min===0){ const n = parseInt(t); if(n) min = n; }
  return min;
}

function slugify(str){
  const SPECIAL_SLUGS = {
    'Irã (Pérsia)': 'ira--persia',
    'Líbano & Levante': 'libano---levante',
    'Brasil':'brasil','França':'franca','Itália':'italia','Japão':'japao',
    'México':'mexico','Espanha':'espanha','Marrocos':'marrocos',
    'Alemanha':'alemanha','Reino Unido':'reino-unido','Tailândia':'tailandia',
    'Colômbia':'colombia','Suíça':'suica','Áustria':'austria',
    'África do Sul':'africa-do-sul','Indonésia':'indonesia',
    'Malásia':'malasia','Vietnã':'vietna',
  };
  if(SPECIAL_SLUGS[str]) return SPECIAL_SLUGS[str];
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/&amp;/g,'e')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/(^-|-$)/g,'');
}

function getRecipesForCountry(pais){
  if(pais === 'all') return RECIPES;
  // Inclui receitas regionais (ex.: "Brasil (Bahia)" conta para "Brasil")
  const core = RECIPES.filter(r=>primaryCountry(r.pais)===pais);
  const extra = recipeCache[slugify(pais)] || [];
  return [...core, ...extra];
}

function getAllRecipes(){
  let all = [...RECIPES];
  for(const k in recipeCache) all = all.concat(recipeCache[k]);
  return all;
}

function setLoading(v){
  isLoading = v;
  $('#loadingIndicator').classList.toggle('hidden', !v);
}

function toast(msg, duration=2500){
  let t = $('.toast');
  if(!t){
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(()=>t.classList.add('show'));
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'), duration);
}

// ---------- Lazy loading ----------
async function loadCountryRecipes(pais){
  const slug = slugify(pais);
  if(recipeCache[slug]) return recipeCache[slug];
  if(pais === 'all') return [];
  setLoading(true);
  try{
    const res = await fetch(`receitas/${slug}.json`);
    if(!res.ok) throw new Error('not found');
    const data = await res.json();
    recipeCache[slug] = (data.recipes||[]).map(r=>({...r,isExtra:true}));
  }catch(e){
    recipeCache[slug] = [];
  }
  setLoading(false);
  // Atualiza o chip do país para mostrar o total exato após carregar
  refreshCountryChip(pais);
  return recipeCache[slug];
}

function refreshCountryChip(pais){
  const chip = $(`.country-chip[data-pais="${CSS.escape(pais)}"]`);
  if(!chip) return;
  const base = RECIPES.filter(r=>primaryCountry(r.pais)===pais).length;
  const extra = (recipeCache[slugify(pais)]||[]).length;
  const total = base + extra;
  const small = chip.querySelector('small');
  if(small) small.textContent = `(${total})`;
}

// ---------- Estatísticas ----------
// Contagens exatas de receitas extras por país (core + arquivos receitas/*.json)
// Atualizado via script de contagem — manter sincronizado ao adicionar novas receitas.
const EXTRA_COUNTS = {
  'Alemanha':10,'Argentina':13,'Arábia Saudita':1,'Austrália':11,
  'Brasil':28,'Bélgica':11,'Canadá':10,'Chile':10,'China':11,'Colômbia':11,
  'Coreia':9,'Costa Rica':1,'Cuba':9,'Dinamarca':2,'Egito':9,'El Salvador':1,
  'Escócia':2,'Espanha':12,'Estados Unidos':9,'Etiópia':6,'Filipinas':10,
  'Finlândia':1,'França':21,'Grécia':12,'Guatemala':1,'Holanda':10,'Hungria':9,
  'Indonésia':9,'Irlanda':2,'Irã (Pérsia)':9,'Israel':8,'Itália':16,'Jamaica':8,
  'Japão':17,'Líbano & Levante':9,'Malásia':8,'Marrocos':11,'México':13,
  'Nepal':1,'Nigéria':8,'Noruega':9,'Nova Zelândia':1,'Panamá':1,'Paquistão':9,
  'Peru':13,'Polônia':9,'Portugal':12,'Reino Unido':11,'República Dominicana':1,
  'Rússia':10,'Sri Lanka':1,'Suécia':11,'Suíça':9,'Tailândia':11,
  'Trinidad e Tobago':1,'Turquia':11,'Ucrânia':8,'Venezuela':9,'Vietnã':9,
  'África do Sul':9,'Áustria':8,'Índia':13
};
// Receitas regionais no core contam para o país principal (ex.: "Brasil (Bahia)" → Brasil)
const REGIONAL_MAP = {
  'Brasil (Bahia)':'Brasil','China (Cantão)':'China','China (Sichuan)':'China',
  'Argentina &amp; Uruguai':'Argentina','Cuba &amp; Flórida':'Cuba',
  'Espanha (Andaluzia)':'Espanha','Espanha (Valência)':'Espanha',
  'Estados Unidos (Kansas City)':'Estados Unidos','França (Borgonha)':'França',
  'Grécia &amp; Oriente Médio':'Grécia','Itália (Emilia-Romagna)':'Itália',
  'Itália (Milão)':'Itália','Itália (Nápoles)':'Itália','Itália (Roma)':'Itália',
  'Itália (Vêneto)':'Itália','México &amp; Espanha':'México','México (Astecas)':'México',
  'México (Puebla)':'México','Noruega &amp; Escandinávia':'Noruega','Peru (Lima)':'Peru',
  'Polônia &amp; Europa Oriental':'Polônia','Portugal (Belém)':'Portugal',
  'Portugal (Minho)':'Portugal','Portugal (Porto)':'Portugal',
  'Reino Unido (Inglaterra)':'Reino Unido','Turquia (Gaziantep)':'Turquia',
  'Áustria &amp; Alemanha':'Áustria','Índia (Hyderabad)':'Índia',
  'Líbano &amp; Levante':'Líbano & Levante','Oriente Médio':'Líbano & Levante',
  'Oriente Médio (Levante)':'Líbano & Levante','Líbano':'Líbano & Levante'
};

function primaryCountry(pais){
  if(REGIONAL_MAP[pais]) return REGIONAL_MAP[pais];
  return pais.replace(/\s*\([^)]*\)\s*$/,'').trim();
}

function animateStats(){
  const nRecipes = 685; // 150 core + 535 lazy-loaded JSON extras
  const nCountries = Object.keys(EXTRA_COUNTS).length;
  const nCategories = CATEGORIES.length;

  const animateTo = (el, target, dur=2000, suffix='+') => {
    const t0 = performance.now();
    const step = (now)=>{
      const p = Math.min(1,(now-t0)/dur);
      const eased = 1-Math.pow(1-p,3);
      el.textContent = Math.floor(eased*target) + (p>=1?suffix:'+');
      if(p<1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  animateTo($('#statRecipes'), nRecipes, 2400);
  animateTo($('#statCountries'), nCountries, 2600, '');
  animateTo($('#statCategories'), nCategories, 1600, '');
}

// ---------- Categorias ----------
function renderCategories(){
  const all = getAllRecipes();
  const counts = countBy(all, 'categoria');
  const grid = $('#categoryGrid');
  grid.innerHTML = CATEGORIES.map(c => html`
    <div class="category-card animate-in" data-cat="${c.id}">
      <span class="cat-emoji">${svgIcon(CAT_ICONS[c.id]||'i-bread', '', 56)}</span>
      <div class="cat-name">${c.nome}</div>
      <div class="cat-count">${counts[c.id]||0}${currentFilter==='all'?'+':''} receitas</div>
    </div>
  `).join('');
  $$('.category-card', grid).forEach(card=>{
    card.addEventListener('click', ()=>{
      const id = card.dataset.cat;
      currentCategory = currentCategory === id ? null : id;
      currentFilter = 'all';
      currentCategory ? highlightFilters(null) : null;
      resetCountryChips();
      $$('.category-card').forEach(c=>c.classList.toggle('active', c.dataset.cat===currentCategory));
      renderRecipes();
      $('#paises').scrollIntoView({behavior:'smooth',block:'start'});
    });
  });
}

function resetCountryChips(){
  $$('.country-chip').forEach(c=>c.classList.remove('active'));
  const all = $('.country-chip[data-pais="all"]');
  if(all) all.classList.add('active');
}

// ---------- Country Chips ----------
function renderCountryChips(){
  // Conta receitas do core mapeando regionais para o país principal
  const coreCounts = {};
  RECIPES.forEach(r=>{
    const p = primaryCountry(r.pais);
    coreCounts[p] = (coreCounts[p]||0)+1;
  });
  const allCountries = new Set([...Object.keys(coreCounts), ...Object.keys(EXTRA_COUNTS)]);
  const sorted = [...allCountries].sort((a,b)=>a.localeCompare(b,'pt'));
  const chips = $('#countryChips');

  chips.innerHTML =
    `<button class="country-chip active" data-pais="all">${svgIcon('i-globe','',14)} Todos</button>` +
    sorted.map(p=>{
      const base = coreCounts[p]||0;
      const extra = EXTRA_COUNTS[p]||0;
      const total = base + extra;
      // Quando o país ainda não foi carregado, mostramos só o core com "+"
      // (os extras são carregados por lazy load)
      const loaded = !!recipeCache[slugify(p)];
      const label = loaded ? `${total}` : (extra > 0 ? `${base}+` : `${base}`);
      return `<button class="country-chip" data-pais="${p}">${getFlag(p)} ${p} <small style="opacity:.7">(${label})</small></button>`;
    }).join('');

  $$('.country-chip', chips).forEach(chip=>{
    chip.addEventListener('click', async ()=>{
      const pais = chip.dataset.pais;
      $$('.country-chip').forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = pais;
      currentCategory = null;
      $$('.category-card').forEach(c=>c.classList.remove('active'));
      highlightFilters(null);
      if(pais !== 'all') await loadCountryRecipes(pais);
      renderRecipes();
      renderCategories();
      updateFavCount();
    });
  });
}

// Mapeamento país → código ISO do arquivo SVG em assets/flags/
const FLAG_CODES = {
  'Alemanha':'de','Argentina':'ar','Arábia Saudita':'sa','Austrália':'au',
  'Áustria':'at','Bélgica':'be','Brasil':'br','Canadá':'ca','Chile':'cl',
  'China':'cn','Colômbia':'co','Coreia':'kr','Costa Rica':'cr','Cuba':'cu',
  'Dinamarca':'dk','Egito':'eg','El Salvador':'sv','Escócia':'gb-sct',
  'Espanha':'es','Estados Unidos':'us','Etiópia':'et','Filipinas':'ph',
  'Finlândia':'fi','França':'fr','Grécia':'gr','Guatemala':'gt',
  'Holanda':'nl','Hungria':'hu','Índia':'in','Indonésia':'id','Irlanda':'ie',
  'Irã (Pérsia)':'ir','Israel':'il','Itália':'it','Jamaica':'jm','Japão':'jp',
  'Líbano & Levante':'lb','Malásia':'my','Marrocos':'ma','México':'mx',
  'Nepal':'np','Nigéria':'ng','Noruega':'no','Nova Zelândia':'nz',
  'Panamá':'pa','Paquistão':'pk','Peru':'pe','Polônia':'pl','Portugal':'pt',
  'Reino Unido':'gb','República Dominicana':'do','Rússia':'ru',
  'Sri Lanka':'lk','Suécia':'se','Suíça':'ch','Tailândia':'th',
  'Trinidad e Tobago':'tt','Turquia':'tr','Ucrânia':'ua','Venezuela':'ve',
  'Vietnã':'vn','África do Sul':'za'
};

function flagSvg(pais, sizeClass=''){
  // Retorna <img> apontando para bandeira vetorial. Aceita país canônico ou regional.
  const pp = primaryCountry(pais);
  const code = FLAG_CODES[pp] || FLAG_CODES[pais];
  if(!code) return '';
  // alt vazio é intencional — o nome do país já aparece ao lado na UI
  return `<img class="flag-svg ${sizeClass}" src="assets/flags/${code}.svg" alt="" loading="lazy" decoding="async">`;
}

function getFlag(pais){
  // Compat: retorna bandeira SVG do país. (Chamado para chips, cards, modais.)
  return flagSvg(pais);
}

// ---------- Renderizar lista de receitas ----------
function renderRecipes(){
  const list = $('#recipeList');
  let filtered;
  if(currentFilter === 'all'){
    filtered = currentCategory ? getAllRecipes().filter(r=>r.categoria===currentCategory) : getAllRecipes();
  } else {
    filtered = getRecipesForCountry(currentFilter);
    if(currentCategory) filtered = filtered.filter(r=>r.categoria===currentCategory);
  }
  // busca
  if(searchTerm){
    const s = searchTerm.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    filtered = filtered.filter(r =>
      r.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(s) ||
      r.pais.toLowerCase().includes(s) ||
      (r.ingredientes||[]).some(i=>i.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(s)) ||
      (r.desc||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').includes(s)
    );
  }
  // filtros rápidos
  if(filterTime === 'fast'){
    filtered = filtered.filter(r => parseTime(r.tempo) <= 35);
  }
  if(filterDiff !== 'all'){
    filtered = filtered.filter(r => DIFF_MAP[r.dificuldade] === filterDiff);
  }

  if(filtered.length === 0){
    list.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;">
      <div style="font-size:3rem;">${svgIcon('i-bread','',48)}</div>
      <p style="font-size:1.2rem;margin-top:10px;font-family:var(--ff-hand);">
        Nenhuma receita por aqui… experimente outro filtro ou país!
      </p></div>`;
    return;
  }

  list.innerHTML = filtered.map((r,i)=>html`
    <article class="recipe-card animate-in" data-id="${r.id}" style="animation-delay:${(i%12)*0.03}s">
      <div class="rc-flag">${flagSvg(r.pais)}</div>
      <h3 class="rc-name">${r.nome}${r.isExtra?' <span class="extra-badge">novo</span>':''}</h3>
      <div class="rc-origin">${r.pais}</div>
      <span class="rc-cat">${svgIcon(META_ICONS.category,'pill-icon-sm')} ${catName(r.categoria)}</span>
      <div class="rc-time">${svgIcon(META_ICONS.time,'pill-icon-sm')} ${r.tempo}</div>
    </article>
  `).join('');

  $$('.recipe-card', list).forEach(card=>{
    card.addEventListener('click', ()=>openRecipe(card.dataset.id));
  });
}

// ---------- Renderizar listas do usuário ----------
function recipeCardHtml(r, extraBadge){
  return html`
    <article class="recipe-card animate-in" data-id="${r.id}">
      <div class="rc-flag">${flagSvg(r.pais)}</div>
      <h3 class="rc-name">${r.nome}</h3>
      <div class="rc-origin">${r.pais}</div>
      <span class="rc-cat">${svgIcon(META_ICONS.category,'pill-icon-sm')} ${catName(r.categoria)}</span>
      <div class="rc-time">${svgIcon(META_ICONS.time,'pill-icon-sm')} ${r.tempo}</div>
      ${extraBadge||''}
    </article>`;
}
function bindCards(container){
  $$('.recipe-card', container).forEach(card=>{
    card.addEventListener('click', ()=>openRecipe(card.dataset.id));
  });
}

function renderFavs(){
  const list = $('#favList');
  const empty = $('#favEmpty');
  const sec = $('#favoritos');
  const ids = favs();
  const favRecipes = ids.map(id=>findRecipeById(id)).filter(Boolean);
  if(Auth.isLoggedIn() && !sec.hidden && ids.length===0){
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  if(favRecipes.length === 0){
    empty.classList.remove('hidden');
    list.innerHTML = '';
    if(!Auth.isLoggedIn()) sec.hidden = true;
    return;
  }
  sec.hidden = false;
  empty.classList.add('hidden');
  list.innerHTML = favRecipes.map(r=>recipeCardHtml(r)).join('');
  bindCards(list);
}

function renderMade(){
  if(!Auth.isLoggedIn()) return;
  const list = $('#madeList');
  const empty = $('#madeEmpty');
  const sec = $('#feitasesao');
  const made = Auth.made();
  const ids = Object.keys(made);
  const recipes = ids.map(id=>findRecipeById(id)).filter(Boolean);
  if(recipes.length === 0){
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = recipes.map(r=>{
    const m = made[r.id];
    const stars = m.rating
      ? `<span class="rc-rating-num" title="Nota ${m.rating}/5">★ ${m.rating}/5</span>`
      : '';
    return recipeCardHtml(r, stars);
  }).join('');
  bindCards(list);
}

function renderWish(){
  if(!Auth.isLoggedIn()) return;
  const list = $('#wishList');
  const empty = $('#wishEmpty');
  const sec = $('#querofazer');
  const ids = [...Auth.wish()];
  const recipes = ids.map(id=>findRecipeById(id)).filter(Boolean);
  if(recipes.length === 0){
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = recipes.map(r=>recipeCardHtml(r)).join('');
  bindCards(list);
}

function renderUserSections(){
  renderMade();
  renderWish();
  renderFavs();
}

function updateFavCount(){
  if(window.Auth) return Auth.updateFavCount();
  const badge = $('#favCount');
  if(!badge) return;
  badge.textContent = favorites.length;
  badge.classList.toggle('hidden', favorites.length===0);
}

async function toggleFav(id){
  if(window.Auth && Auth.isLoggedIn()){
    await Auth.toggleFav(id, $('#favBtn'));
  } else {
    const idx = favorites.indexOf(id);
    if(idx >=0){ removeFavLocal(id); toast('Removido dos favoritos'); }
    else { addFavLocal(id); toast('Adicionado aos favoritos!'); }
  }
  updateFavBtn();
  updateFavCount();
  renderFavs();
}

function updateFavBtn(){
  // O Auth.updateModalButtons() cuida dos estados visuais quando logado
  if(window.Auth && Auth.isLoggedIn()) return Auth.updateModalButtons();
  const btn = $('#favBtn');
  if(!btn || !activeRecipe) return;
  btn.classList.toggle('favorited', isFav(activeRecipe.id));
  const wb = $('#wishBtn'), mb = $('#madeBtn');
  if(wb) wb.classList.remove('favorited');
  if(mb) mb.classList.remove('favorited');
  $('#madePanel').classList.add('hidden');
}

// ---------- Cards destaque ----------
function renderFeatured(){
  const featuredNames = ['pao-de-queijo','croissant','pizza-margherita','sushi',
                        'tacos-al-pastor','paella','pho','butter-chicken'];
  const featured = featuredNames.map(n=>RECIPES.find(r=>r.id===n)).filter(Boolean);
  $('#featuredGrid').innerHTML = featured.map((r,i)=>html`
    <article class="featured-card animate-in" data-id="${r.id}" style="animation-delay:${i*0.08}s">
      <div class="featured-top">
        <span class="featured-flag">${flagSvg(r.pais,'flag-lg')}</span>
        <h3 class="featured-name">${r.nome}</h3>
        <div class="featured-origin">${r.pais}</div>
      </div>
      <div class="featured-body">
        <p class="featured-desc">${r.desc}</p>
        <div class="featured-meta">
          <span class="meta-pill">${svgIcon(META_ICONS.time,'pill-icon')} ${r.tempo}</span>
          <span class="meta-pill">${svgIcon(META_ICONS.difficulty,'pill-icon')} ${r.dificuldade}</span>
          <span class="meta-pill">${svgIcon(META_ICONS.category,'pill-icon')} ${catName(r.categoria)}</span>
        </div>
        <button class="bake-btn" data-id="${r.id}">${svgIcon('i-bread','btn-icon')} Ver Receita</button>
      </div>
    </article>
  `).join('');
  $$('#featuredGrid [data-id]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      openRecipe(el.dataset.id);
    });
  });
}

// ---------- Modal ----------
function findRecipeById(id){
  let r = RECIPES.find(x=>x.id===id);
  if(r) return r;
  for(const k in recipeCache){
    r = recipeCache[k].find(x=>x.id===id);
    if(r) return r;
  }
  return null;
}

function openRecipe(id){
  const r = findRecipeById(id);
  if(!r) return;
  activeRecipe = r;

  const modalFlag = $('#modalFlag');
  modalFlag.innerHTML = flagSvg(r.pais, 'flag-lg');
  $('#modalTitle').textContent = r.nome;
  $('#modalOrigin').innerHTML = `${svgIcon('i-globe','pill-icon-sm')} Uma tradição de ${r.pais}`;
  // Popula meta dinamicamente (sem emojis)
  $('#modalMeta').innerHTML = [
    [META_ICONS.time, r.tempo],
    [META_ICONS.servings, r.porcoes],
    [META_ICONS.difficulty, r.dificuldade],
    [META_ICONS.category, catName(r.categoria)]
  ].map(([ic,tx])=>`<span class="meta-pill">${svgIcon(ic,'pill-icon')} ${tx}</span>`).join('');
  $('#modalStory').textContent = r.historia;
  $('#modalTip').textContent = r.dica;

  // Inicializa conversor de porções
  initServings(r);
  // Renderiza ingredientes (escalados) e passos (com botão de timer)
  renderIngredients(r, servingsScale);
  renderSteps(r);

  updateFavBtn();
  const modal = $('#recipeModal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const card = $('.modal-card', modal);
  if(card) card.scrollTop = 0;

  // Atualiza hash
  history.replaceState(null,'',`#receita=${encodeURIComponent(id)}`);
}

function closeModal(){
  $('#recipeModal').classList.add('hidden');
  document.body.style.overflow = '';
  if(cookModeOn) exitCookMode();
  history.replaceState(null,'',' ');
  activeRecipe = null;
}

// ---------- Modo Cozinha ----------
async function enterCookMode(){
  try{
    if('wakeLock' in navigator){
      wakeLock = await navigator.wakeLock.request('screen');
    }
  }catch(e){}
  cookModeOn = true;
  document.body.classList.add('cook-mode');
  $('#cookModeBar').classList.remove('hidden');
  const icon = $('#cookModeIcon use');
  icon.setAttribute('href','assets/icons.svg#i-fullscreen-exit');
  // Auto scroll para o modo de preparo
  const prep = $('.prep-col');
  if(prep) setTimeout(()=>prep.scrollIntoView({behavior:'smooth',block:'start'}), 200);
}
function exitCookMode(){
  if(wakeLock){ try{ wakeLock.release(); }catch(e){} wakeLock = null; }
  cookModeOn = false;
  document.body.classList.remove('cook-mode');
  $('#cookModeBar').classList.add('hidden');
  const icon = $('#cookModeIcon use');
  icon.setAttribute('href','assets/icons.svg#i-fullscreen');
}
function toggleCookMode(){ cookModeOn ? exitCookMode() : enterCookMode(); }

/* ==========================================================
   1) CONVERSOR DE PORÇÕES
   ========================================================== */
let servingsScale = 1;   // multiplicador de escala
let baseServings  = 4;   // número de porções base da receita

// Extrai número de porções de strings como "4 porções", "6 unidades", "2 pessoas"
function parseServings(txt){
  if(!txt) return 4;
  const m = txt.match(/(\d+(?:[,.]\d+)?)/);
  if(!m) return 4;
  return parseFloat(m[1].replace(',','.'));
}

// Detecta quantidades no início de um ingrediente.
// Padrões: "2 xícaras de farinha", "1/2 colher de sal", "300g de carne",
//          "1,5 xícara", "1 lata", "2 ovos"
// Divide em { qtd, unidade, resto }
const QTY_RE = /^\s*(\d+(?:[,.]\d+)?(?:\s*\/\s*\d+)?|\d+\/\d+)\s*(g|gr|gramas?|kg|kgs|ml|l|litros?|xíc(?:ara)?s?|colh?e?r(?:es)??(?:\s*\(?:sopa|chá|café|sobremesa\))?|colheres?(?:\s*de\s*(?:sopa|chá|café|sobremesa))?|c\.sopa|c\.chá|c\.café|cs|cc|colher|pitada[s]?|pitadas|lata[s]?|latinha[s]?|pacote[s]?|copo[s]?|dente[s]?|folha[s]?|fatias?|cubos?|unidades?|unid\.)?\b\s*/i;

function parseQty(ing){
  // Normaliza frações unicode: ½, ¼, ¾, ⅓, ⅔
  const uniMap={'½':0.5,'¼':0.25,'¾':0.75,'⅓':1/3,'⅔':2/3,'⅛':0.125,'⅜':0.375,'⅝':0.625,'⅞':0.875};
  let s = ing;
  for(const k in uniMap) s = s.replace(k, ' '+uniMap[k]+' ');
  s = s.replace(/–/g,'-').replace(/—/g,'-');
  const m = s.match(QTY_RE);
  if(!m) return { qty:null, unit:'', rest:ing.trim() };
  let qtyStr = m[1].trim().replace(',','.');
  // avalia frações como "1/2" ou "2 1/2"
  let qty;
  const frac = qtyStr.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if(frac) qty = parseInt(frac[1]) + parseInt(frac[2])/parseInt(frac[3]);
  else if(qtyStr.match(/^\d+\/\d+$/)){
    const p = qtyStr.split('/');
    qty = parseInt(p[0])/parseInt(p[1]);
  } else qty = parseFloat(qtyStr);
  const unit = m[2]||'';
  const rest = s.substring(m[0].length).trim();
  return { qty, unit, rest };
}

function fmtQty(n){
  if(n===null||n===undefined) return '';
  // Números redondos
  if(Math.abs(n-Math.round(n))<0.02) return Math.round(n).toString();
  // Meios e quartos comuns
  const fracs=[
    [0.25,'¼'],[0.33,'⅓'],[0.5,'½'],[0.66,'⅔'],[0.75,'¾'],
    [0.2,'⅕'],[0.4,'⅖'],[0.6,'⅗'],[0.8,'⅘']
  ];
  const whole = Math.floor(n);
  const frac = n - whole;
  for(const [v,s] of fracs){
    if(Math.abs(frac-v)<0.04){
      return whole>0 ? `${whole} ${s}` : s;
    }
  }
  // fallback: 1 casa decimal se pequeno, ou 0 casas se grande
  return n<10 ? n.toFixed(1).replace('.',',') : Math.round(n).toString();
}

function scaleIngredient(ing, scale){
  if(scale===1) return ing;
  const { qty, unit, rest } = parseQty(ing);
  if(qty===null) return ing;
  const newQty = qty*scale;
  const qtyStr = fmtQty(newQty);
  const sp = unit ? ' ' : '';
  return `${qtyStr}${sp}${unit}${unit?' ':''}${rest}`;
}

function renderIngredients(r, scale){
  const list = (r.ingredientes||[]).map(ing=>{
    const scaled = scaleIngredient(ing, scale);
    return `<li><label class="ing-check"><input type="checkbox" class="ing-cb"><span class="ing-text">${scaled}</span><span class="ing-checkmark"></span></label></li>`;
  }).join('');
  $('#modalIngredients').innerHTML = list;
}

function initServings(r){
  baseServings = parseServings(r.porcoes);
  servingsScale = 1;
  $('#servNumber').textContent = baseServings;
  $('#servText').textContent = (r.porcoes||'').toString().replace(/^\d+\s*/,'').trim() || 'porções';
  $('#servingsBar').classList.remove('hidden');
  $('#servDec').disabled = true;
}

function changeServings(delta){
  const newBase = Math.max(1, Math.min(99, parseServings($('#servNumber').textContent)+delta));
  servingsScale = newBase/baseServings;
  $('#servNumber').textContent = newBase;
  $('#servDec').disabled = (newBase<=1);
  if(activeRecipe) renderIngredients(activeRecipe, servingsScale);
}

/* ==========================================================
   2) MODO ESCURO (tema chalkboard noturno)
   ========================================================== */
let darkMode = localStorage.getItem('padaria_dark')==='1';
function applyDark(){
  document.documentElement.classList.toggle('dark', darkMode);
  const icon = $('#themeIcon use');
  if(icon){
    icon.setAttribute('href', darkMode ? 'assets/icons.svg#i-sun' : 'assets/icons.svg#i-moon');
  }
}
function toggleDark(){
  darkMode = !darkMode;
  localStorage.setItem('padaria_dark', darkMode?'1':'0');
  applyDark();
}

/* ==========================================================
   3) LISTA DE COMPRAS (persistida em localStorage)
   ========================================================== */
let shopList = JSON.parse(localStorage.getItem('padaria_shoplist')||'[]');
// Formato: [{ id (ingrediente normalizado), text, checked, from (nome da receita) }]
function saveShop(){
  localStorage.setItem('padaria_shoplist', JSON.stringify(shopList));
  updateShopCount();
}
function normalizeIng(s){
  // Remove quantidade inicial, para agrupar itens iguais
  const {unit, rest} = parseQty(s);
  return rest.toLowerCase().replace(/\s+/g,' ').replace(/[.,;!?:]$/,'').trim();
}
function addRecipeToShop(r){
  const before = shopList.length;
  (r.ingredientes||[]).forEach(ing=>{
    const key = normalizeIng(ing);
    if(!shopList.find(x=>x.id===key)){
      shopList.push({id:key, text:ing, checked:false, from:r.nome});
    }
  });
  saveShop();
  renderShop();
  const added = shopList.length-before;
  toast(added>0 ? `+${added} itens na lista de compras!` : 'Tudo já estava na lista 🧺');
  openShop();
}
function removeShopItem(id){
  shopList = shopList.filter(x=>x.id!==id);
  saveShop(); renderShop();
}
function toggleShopItem(id){
  const it = shopList.find(x=>x.id===id);
  if(it) it.checked = !it.checked;
  saveShop(); renderShop();
}
function clearShop(){
  if(!shopList.length) return;
  if(!confirm('Limpar toda a lista de compras?')) return;
  shopList=[]; saveShop(); renderShop();
}
function copyShop(){
  if(!shopList.length){ toast('A lista está vazia'); return;}
  const txt = '🛒 LISTA DE COMPRAS — Padaria do Mundo\n\n' +
    shopList.map(x=>`${x.checked?'☑':'☐'} ${x.text}${x.from?` (p/ ${x.from})`:''}`).join('\n');
  navigator.clipboard.writeText(txt).then(()=>toast('Lista copiada!'),
    ()=>prompt('Copie manualmente:',txt));
}
function printShop(){
  if(!shopList.length){ toast('A lista está vazia'); return;}
  const w = window.open('','_blank');
  w.document.write(`<html><head><title>Lista de Compras</title><style>
    body{font-family:Georgia,serif;padding:40px;max-width:600px;margin:0 auto;color:#3a200a;}
    h1{font-family:cursive;color:#8B4513;border-bottom:3px dotted #C17A3C;padding-bottom:10px;}
    li{margin:10px 0;font-size:1.1rem;list-style:none;border-bottom:1px dashed #ccc;padding:6px 0;}
    .from{color:#999;font-style:italic;font-size:.85rem;display:block;}
    input{transform:scale(1.3);margin-right:10px;}
  </style></head><body><h1>🛒 Lista de Compras</h1><ul>
    ${shopList.map(x=>`<li><label><input type="checkbox"${x.checked?' checked':''} onclick="return false"> ${x.text}<span class="from">para ${x.from}</span></label></li>`).join('')}
  </ul></body></html>`);
  w.document.close();
  setTimeout(()=>w.print(),500);
}
function openShop(){
  const p = $('#shoplistPanel');
  const b = $('#shoplistBackdrop');
  p.classList.add('open');
  b.classList.remove('hidden');
  p.setAttribute('aria-hidden','false');
  document.body.style.overflow='hidden';
}
function closeShop(){
  $('#shoplistPanel').classList.remove('open');
  $('#shoplistBackdrop').classList.add('hidden');
  $('#shoplistPanel').setAttribute('aria-hidden','true');
  if(!$('#recipeModal').classList.contains('hidden')) return;
  document.body.style.overflow='';
}
function updateShopCount(){
  const badge = $('#shoplistCount');
  if(!badge) return;
  const n = shopList.length;
  badge.textContent = n;
  badge.classList.toggle('hidden', n===0);
}
function renderShop(){
  const list = $('#shoplistItems');
  const empty = $('#shoplistEmpty');
  const info = $('#shoplistInfo');
  if(!list) return;
  if(!shopList.length){
    list.innerHTML=''; empty.classList.remove('hidden'); info.textContent='0 itens'; return;
  }
  empty.classList.add('hidden');
  // Agrupa por categoria simples (laticínios, hortifruti, etc. — vamos fazer só por receita)
  list.innerHTML = shopList.map(x=>`
    <li class="shop-item ${x.checked?'checked':''}">
      <label>
        <input type="checkbox" ${x.checked?'checked':''} data-id="${x.id}" class="shop-cb">
        <span class="shop-text">${x.text}${x.from?`<small class="shop-from"> · ${x.from}</small>`:''}</span>
      </label>
      <button class="shop-del" data-id="${x.id}" aria-label="Remover">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </li>`).join('');
  const pend = shopList.filter(x=>!x.checked).length;
  info.textContent = `${shopList.length} itens (${pend} pendentes)`;
  $$('.shop-cb', list).forEach(cb=>{
    cb.addEventListener('change',()=>toggleShopItem(cb.dataset.id));
  });
  $$('.shop-del', list).forEach(b=>{
    b.addEventListener('click',()=>removeShopItem(b.dataset.id));
  });
}

/* ==========================================================
   4) TIMER DE COZINHA (extraível e com som)
   ========================================================== */
let timerInterval = null;
let timerEnd = 0;
let timerLabel = '';

function parseStepTime(text){
  // Extrai tempo mencionado no passo: "cozinhe por 15 min", "asse por 1h", "ferva 30 segundos"
  const times = [];
  const re = /(\d+)\s*(min(?:uto)?s?|h(?:ora)?s?|seg(?:undo)?s?)\b/gi;
  let m;
  while((m=re.exec(text))!==null){
    const n = parseInt(m[1]);
    const u = m[2].toLowerCase();
    let s = 0;
    if(u.startsWith('h')) s = n*3600;
    else if(u.startsWith('min')) s = n*60;
    else s = n;
    // Ignora tempos muito longos (>3h) ou curtos demais (<10seg)
    if(s>=10 && s<=3*3600) times.push(s);
  }
  return times.length ? times[0] : null;
}
function fmtTimer(s){
  if(s<0)s=0;
  const m=Math.floor(s/60), sec=s%60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function beep(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const o=ctx.createOscillator(); const g=ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value=880; o.type='sine'; g.gain.value=.3;
    o.start();
    setTimeout(()=>{o.frequency.value=660;},300);
    setTimeout(()=>{o.frequency.value=880;},600);
    setTimeout(()=>{g.gain.setTargetAtTime(0,ctx.currentTime,.1); o.stop(ctx.currentTime+.3); ctx.close();},900);
    // Tenta vibrar no celular
    if(navigator.vibrate) navigator.vibrate([300,100,300,100,500]);
  }catch(e){}
}
function startTimer(seconds, label){
  clearInterval(timerInterval);
  timerEnd = Date.now() + seconds*1000;
  timerLabel = label || 'Timer';
  const el = $('#timerFloat');
  el.classList.remove('hidden');
  $('#timerLabel').textContent = timerLabel;
  document.querySelector('.timer-ring').classList.remove('ringing');
  const tick = ()=>{
    const left = Math.max(0, Math.round((timerEnd-Date.now())/1000));
    $('#timerTime').textContent = fmtTimer(left);
    document.title = left>0 ? `⏱ ${fmtTimer(left)} — Padaria do Mundo` : 'Padaria do Mundo';
    if(left<=0){
      clearInterval(timerInterval);
      document.title='Padaria do Mundo';
      beep();
      el.classList.add('done');
      document.querySelector('.timer-ring').classList.add('ringing');
      $('#timerLabel').textContent = 'Pronto!';
      if(window.Notification && Notification.permission==='granted'){
        new Notification('⏰ Timer! '+timerLabel, {body:'O tempo acabou!'});
      }
    }
  };
  tick();
  timerInterval = setInterval(tick,1000);
  // Pede permissão de notificação no primeiro timer
  if(window.Notification && Notification.permission==='default') Notification.requestPermission();
}
function stopTimer(){
  clearInterval(timerInterval);
  $('#timerFloat').classList.add('hidden');
  $('#timerFloat').classList.remove('done');
  document.querySelector('.timer-ring')?.classList.remove('ringing');
  document.title='Padaria do Mundo';
}
// Renderiza passos com botão de timer embutido
function renderSteps(r){
  const html = (r.passos||[]).map((p,i)=>{
    const sec = parseStepTime(p);
    const timerBtn = sec
      ? `<button class="step-timer" data-time="${sec}" title="Iniciar timer de ${fmtTimer(sec)}" aria-label="Timer"><svg width="16" height="16"><use href="assets/icons.svg#i-clock"/></svg> <span class="step-timer-time">${fmtTimer(sec)}</span></button>`
      : '';
    return `<li data-idx="${i}"><span class="step-text">${p}</span>${timerBtn}</li>`;
  }).join('');
  $('#modalSteps').innerHTML = html;
  $$('.step-timer', $('#modalSteps')).forEach(b=>{
    b.addEventListener('click', e=>{
      e.stopPropagation();
      const t = parseInt(b.dataset.time);
      // Tenta pegar o nome curto do passo
      const lbl = (b.parentElement.querySelector('.step-text')?.textContent||'').slice(0,40)+'…';
      startTimer(t, b.querySelector('.step-timer-time').textContent+' — '+activeRecipe?.nome);
    });
  });
}

/* ==========================================================
   Fim das novas features
   ========================================================== */

// ---------- Busca ----------
function setupSearch(){
  const btn = $('#searchToggle');
  const bar = $('#searchBar');
  const input = $('#searchInput');
  const close = $('#searchClose');
  btn.addEventListener('click', ()=>{
    bar.classList.toggle('hidden');
    if(!bar.classList.contains('hidden')) input.focus();
  });
  close.addEventListener('click', ()=>{
    bar.classList.add('hidden');
    input.value=''; searchTerm=''; renderRecipes();
  });
  input.addEventListener('input', e=>{
    searchTerm = e.target.value.trim();
    currentFilter='all'; currentCategory=null;
    resetCountryChips();
    $$('.category-card').forEach(c=>c.classList.remove('active'));
    highlightFilters(null);
    renderRecipes();
  });
}

// ---------- Filtros rápidos ----------
function highlightFilters(){
  $$('.chip-filter').forEach(ch=>{
    const t = ch.dataset.time, d = ch.dataset.diff;
    let active = false;
    if(t && (t === filterTime)) active = true;
    if(d && (d === filterDiff)) active = true;
    if(!t && !d){ active = filterTime==='all' && filterDiff==='all'; }
    ch.classList.toggle('active', active);
  });
}
function setupQuickFilters(){
  $$('.chip-filter').forEach(ch=>{
    ch.addEventListener('click', ()=>{
      if(ch.dataset.time){
        filterTime = ch.dataset.time;
      } else if(ch.dataset.diff){
        filterDiff = ch.dataset.diff==='reset'?'all':ch.dataset.diff;
      }
      // "Todos" reseta
      if(ch.dataset.time==='all' && !ch.dataset.diff){ filterTime='all'; filterDiff='all'; }
      highlightFilters();
      renderRecipes();
    });
  });
}

// ---------- Botão voltar ao topo ----------
function setupBackToTop(){
  const btn = $('#backToTop');
  window.addEventListener('scroll', ()=>{
    btn.classList.toggle('hidden', window.scrollY < 400);
  });
  btn.addEventListener('click', ()=>{
    window.scrollTo({top:0,behavior:'smooth'});
  });
}

// ---------- Mobile menu ----------
function setupMobile(){
  const ham = $('#hamburger');
  const nav = $('.main-nav');
  if(!ham) return;
  ham.addEventListener('click', ()=>{
    ham.classList.toggle('open');
    nav.classList.toggle('open');
  });
  $$('.main-nav a').forEach(a=>{
    a.addEventListener('click', ()=>{
      ham.classList.remove('open');
      nav.classList.remove('open');
    });
  });
}

// ---------- Ações do modal ----------
function setupModalActions(){
  // fechar
  $$('#recipeModal [data-close]').forEach(el=>el.addEventListener('click', closeModal));
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape'){
      if(!$('#shoplistPanel')?.classList.contains('open') &&
         !$('#recipeModal').classList.contains('hidden')) closeModal();
      else if($('#shoplistPanel')?.classList.contains('open')) closeShop();
    }
  });
  // favoritar
  $('#favBtn').addEventListener('click', ()=>{ if(activeRecipe) toggleFav(activeRecipe.id); });
  // imprimir
  $('#printBtn').addEventListener('click', ()=>window.print());
  // compartilhar
  $('#shareBtn').addEventListener('click', async ()=>{
    if(!activeRecipe) return;
    const url = `${location.origin}${location.pathname}#receita=${activeRecipe.id}`;
    try{
      await navigator.clipboard.writeText(url);
      toast('Link copiado! Compartilhe com quem ama cozinhar');
    }catch(e){
      prompt('Copie este link:', url);
    }
  });
  // modo cozinha
  $('#cookModeBtn').addEventListener('click', toggleCookMode);
  $('#exitCookMode').addEventListener('click', exitCookMode);

  // conversor de porções
  $('#servDec').addEventListener('click', ()=>changeServings(-1));
  $('#servInc').addEventListener('click', ()=>changeServings(+1));

  // adicionar à lista de compras
  $('#shopBtn').addEventListener('click', ()=>{
    if(activeRecipe) addRecipeToShop(activeRecipe);
  });
}

// ---------- Setup extras (shoplist, timer, theme) ----------
function setupExtras(){
  // theme toggle
  applyDark();
  $('#themeToggle')?.addEventListener('click', toggleDark);

  // shoplist
  updateShopCount();
  renderShop();
  $('#shoplistBtn')?.addEventListener('click', openShop);
  $('#shoplistClose')?.addEventListener('click', closeShop);
  $('#shoplistBackdrop')?.addEventListener('click', closeShop);
  $('#shoplistClear')?.addEventListener('click', clearShop);
  $('#shoplistCopy')?.addEventListener('click', copyShop);
  $('#shoplistPrint')?.addEventListener('click', printShop);
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape' && $('#shoplistPanel')?.classList.contains('open')) closeShop();
  });

  // timer
  $('#timerStop')?.addEventListener('click', stopTimer);
}

// ---------- Receita surpresa ----------
function setupSurprise(){
  $('#randomBtn').addEventListener('click', async ()=>{
    // Escolhe um país canônico (não regional) para carregar extras
    const paises = Object.keys(EXTRA_COUNTS);
    const paisEscolhido = paises[Math.floor(Math.random()*paises.length)];
    await loadCountryRecipes(paisEscolhido);
    const all = getAllRecipes();
    const r = all[Math.floor(Math.random()*all.length)];
    // scroll para receitas antes de abrir
    $('#paises').scrollIntoView({behavior:'smooth'});
    setTimeout(()=>openRecipe(r.id), 500);
  });
}

// ---------- Newsletter ----------
function setupNewsletter(){
  const form = $('#newsletterForm');
  const input = $('#emailInput');
  const msg = $('#newsletterMsg');
  form.addEventListener('submit', e=>{
    e.preventDefault();
    const email = input.value.trim();
    if(!email || !email.includes('@')){
      msg.style.color='var(--tomato-dark)';
      msg.innerHTML = `${svgIcon('i-bread','pill-icon')} Esse e-mail parece errado, tente de novo!`;
      return;
    }
    msg.style.color='var(--leaf-dark)';
    msg.innerHTML = `${svgIcon('i-mail','pill-icon')} <strong>${email}</strong> já está na lista! Uma receita fresquinha chegará em breve!`;
    input.value='';
    setTimeout(()=>msg.textContent='', 8000);
  });
}

// ---------- Navegação / scroll ----------
function setupNav(){
  $$('.main-nav a[href^="#"]').forEach(a=>{
    a.addEventListener('click', e=>{
      const id = a.getAttribute('href');
      if(id.length>1){
        e.preventDefault();
        $(id)?.scrollIntoView({behavior:'smooth',block:'start'});
      }
    });
  });
}

// ---------- Confete ----------
function sprinkleConfetti(originEl){
  const icons = ['i-bread','i-cupcake','i-wheat','i-rollingpin','i-spoon','i-pancake','i-coffee','i-bread','i-heart','i-fire'];
  const rect = originEl.getBoundingClientRect();
  for(let i=0; i<12; i++){
    const span = document.createElement('span');
    const id = icons[Math.floor(Math.random()*icons.length)];
    span.innerHTML = svgIcon(id,'',14+Math.floor(Math.random()*14));
    span.style.cssText = `
      position:fixed;left:${rect.left+rect.width/2+(Math.random()*100-50)}px;
      top:${rect.top+rect.height/2}px;pointer-events:none;z-index:9999;
      transition:transform 1.3s cubic-bezier(.2,.8,.3,1.2), opacity 1.3s ease-out;
      display:inline-block;`;
    document.body.appendChild(span);
    requestAnimationFrame(()=>{
      span.firstChild.style.transform = `translate(${(Math.random()-.5)*240}px, ${90+Math.random()*130}px) rotate(${(Math.random()-.5)*620}deg)`;
      span.style.opacity='0';
      setTimeout(()=>span.remove(),1400);
    });
  }
}
function setupConfetti(){
  document.addEventListener('click', e=>{
    const btn = e.target.closest('.bake-btn,.nav-btn,.category-card,.recipe-card,.country-chip,.chip-filter');
    if(btn) sprinkleConfetti(btn);
  });
}

// ---------- Inicialização ----------
document.addEventListener('DOMContentLoaded', async ()=>{
  // Carrega estado de autenticação ANTES de renderizar
  favorites = JSON.parse(localStorage.getItem('padaria_favs')||'[]');
  if(window.Auth){
    await Auth.init();
    Auth.setupUI();
  }
  animateStats();
  renderCategories();
  renderFeatured();
  renderCountryChips();
  renderRecipes();
  renderFavs();
  renderUserSections();
  updateFavCount();
  setupSearch();
  setupModalActions();
  setupQuickFilters();
  setupNewsletter();
  setupNav();
  setupBackToTop();
  setupMobile();
  setupSurprise();
  setupConfetti();
  setupExtras();
  highlightFilters();

  // Abrir receita por hash (link compartilhado)
  const m = location.hash.match(/receita=([^&]+)/);
  if(m){
    const id = decodeURIComponent(m[1]);
    const r = RECIPES.find(x=>x.id===id);
    if(r) setTimeout(()=>openRecipe(id), 400);
  }
});
