/* ============================================================================
   DASHBOARD DE FROTAS — JSL
   Lógica da aplicação (JavaScript)
   ----------------------------------------------------------------------------
   Este arquivo depende de:
     - data.js carregado ANTES dele (define a constante global FLEET_RAW,
       gerada pelo script Python etl_frotas.py — ver pasta /python)
     - Os elementos de HTML de index.html (todos os document.getElementById
       usados aqui já existem no HTML antes deste script rodar)

   Índice deste arquivo:
     1. CONSTANTES E MAPEAMENTOS FIXOS (cores, badges, rótulos de status)
     2. PREPARAÇÃO DA BASE (fleet[]) — status real x ilustrativo por frota
     3. ESTADO GLOBAL DE FILTROS E ORDENAÇÃO
     4. UTILITÁRIOS (formatação de moeda, tooltip dos gráficos)
     5. FILTROS — aplica os filtros ativos sobre a base fleet[]
     6. BLOCO "KPIS GERAIS" — 4 cards com ícone
     7. HELPERS DE SVG (usados por todos os gráficos desenhados na mão)
     8. BLOCO "CUSTO TOTAL POR PERÍODO" — gráfico de linha/área
     9. BLOCO "CAUSA RAIZ DAS AVARIAS" — donut de classificação
    10. BLOCO "CAUSA RAIZ DAS AVARIAS" — rankings (peças / frotas)
    11. BLOCO "PREVENTIVA X CORRETIVA" — tabela de frotas (ordenação/render)
    12. PAINEL DE DETALHE DA FROTA (abre ao clicar numa linha da tabela)
    13. EVENTOS DE ORDENAÇÃO DA TABELA (clique no cabeçalho)
    14. EVENTOS DOS FILTROS (inputs/selects da barra de filtro)
    15. EXPORTAÇÃO PARA CSV (botão "Exportar base completa")
    16. renderAll() — o "maestro" que re-desenha tudo a cada mudança de filtro
    17. INICIALIZAÇÃO — primeira renderização ao carregar a página
   ============================================================================ */


/* ============================================================================
   1. CONSTANTES E MAPEAMENTOS FIXOS
   Usados em vários blocos: cor de cada classificação de avaria, classe CSS
   do badge correspondente, e o texto de cada status de preventiva.
   ============================================================================ */
const CLASS_COLORS = {
  'Mau uso':'#c8172f', 'Estrutura':'#f0b429', 'Processo':'#7c5cf0',
  'Preventiva':'#33b26a', 'Regularização':'#2f8fe0', 'N/D':'#b8bcbf'
};
const CLASS_BADGE = {
  'Mau uso':'mau', 'Estrutura':'est', 'Processo':'proc', 'Preventiva':'prev', 'Regularização':'reg'
};
const statusLabel = { g:'Em dia', y:'Próx. vencimento', r:'Vencida', n:'Sem dado' };


/* ============================================================================
   2. PREPARAÇÃO DA BASE (fleet[])
   FLEET_RAW (vindo de data.js) é o array de frotas exportado pelo ETL em
   Python. Aqui adicionamos campos calculados apenas no front-end:
     - modeloDisplay / marcaDisplay: "—" quando não há cadastro
     - status: cor do bloco "Preventiva x Corretiva" para aquela frota
     - hasRealPreventiva: se true, o status vem de um cruzamento real com
       Preventiva_-_Gru.csv; se false, é um placeholder ilustrativo
   ============================================================================ */

/**
 * Decide o status de preventiva (g/y/r/n) de uma frota.
 *   - Se a frota tem f.preventiva (match real do ETL com Preventiva_-_Gru.csv),
 *     usa o campo "proxima_desvio" (em horas) vindo do Python:
 *       desvio > 0        → já venceu (vermelho)
 *       desvio > -300h    → vencendo em breve (amarelo)
 *       caso contrário    → em dia (verde)
 *   - Se NÃO há match real, gera um status pseudo-aleatório mas DETERMINÍSTICO
 *     (hash do código da frota) só para o layout ficar navegável de ponta a
 *     ponta com as 27 frotas que ainda não têm dado real de preventiva.
 */
function realOrPseudoStatus(f){
  if (f.preventiva) {
    const d = f.preventiva.proxima_desvio;
    if (d === null || d === undefined) return 'n';
    if (d > 0) return 'r';        // já venceu
    if (d > -300) return 'y';     // vencendo em breve
    return 'g';
  }
  let h = 0;
  const s = f.frota;
  for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) % 997;
  if (h % 10 < 6) return 'g';
  if (h % 10 < 8) return 'y';
  return 'r';
}

// Base de trabalho usada por TODO o dashboard (tabela, KPIs, gráficos, detalhe).
const fleet = FLEET_RAW.map(f => ({
  ...f,
  modeloDisplay: f.modelo || '—',
  marcaDisplay: f.marca || '—',
  status: realOrPseudoStatus(f),
  hasRealPreventiva: !!f.preventiva
}));


/* ============================================================================
   3. ESTADO GLOBAL DE FILTROS E ORDENAÇÃO
   ============================================================================ */
let sortKey = 'custo';   // coluna atualmente usada para ordenar a tabela
let sortDir = -1;        // -1 = decrescente, 1 = crescente
let activeIdx = null;    // código da frota selecionada no painel de detalhe
let filters = { classe:'', status:'', minCusto:null, search:'' };


/* ============================================================================
   4. UTILITÁRIOS
   ============================================================================ */

// Formata número no padrão monetário brasileiro (1234.5 → "1.234,50")
function fmtBRL(v){
  return v.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

// Tooltip escuro reutilizado por TODOS os gráficos SVG (linha, donut) ao
// passar o mouse sobre pontos/fatias — ver .svg-tooltip em styles.css.
const tooltip = document.getElementById('tooltip');
function showTooltip(evt, text){
  tooltip.textContent = text;
  tooltip.style.left = evt.pageX + 'px';
  tooltip.style.top = evt.pageY + 'px';
  tooltip.classList.add('show');
}
function hideTooltip(){ tooltip.classList.remove('show'); }


/* ============================================================================
   5. FILTROS
   Um único conjunto de filtros (objeto `filters`) afeta simultaneamente:
   KPIs, gráfico de custo, donut de causa raiz, rankings e a tabela de frotas.
   ============================================================================ */

// Retorna só as frotas que passam nos filtros ativos (status / custo mínimo /
// classificação / busca por texto). Usada como primeiro passo de renderAll().
function applyFilters(list){
  return list.filter(f=>{
    if (filters.status && f.status !== filters.status) return false;
    if (filters.minCusto && f.custo < filters.minCusto) return false;
    if (filters.classe && !(f.classes[filters.classe] > 0)) return false;
    const q = filters.search;
    if (q && !(f.frota.toLowerCase().includes(q) ||
               (f.modeloDisplay||'').toLowerCase().includes(q) ||
               (f.marcaDisplay||'').toLowerCase().includes(q))) return false;
    return true;
  });
}

// Dentro de uma frota, filtra o histórico de avarias/custo pela
// classificação selecionada (usado pelo gráfico de custo e pelo donut,
// para que ambos reajam ao filtro "Classificação" do bloco Causa Raiz).
function filteredHist(f){
  if (!filters.classe) return f.hist;
  return f.hist.filter(h=>h.tipo === filters.classe);
}

// Desenha os "chips" removíveis (ex: "Classificação: Mau uso ✕") que
// aparecem logo abaixo dos KPIs quando algum filtro está ativo.
function renderActiveTags(){
  const box = document.getElementById('activeFilterTags');
  const tags = [];
  if (filters.classe) tags.push(['Classificação: '+filters.classe, ()=>{document.getElementById('filterClass').value='';filters.classe='';renderAll();}]);
  if (filters.status) tags.push(['Status: '+statusLabel[filters.status], ()=>{document.getElementById('filterStatus').value='';filters.status='';renderAll();}]);
  if (filters.minCusto) tags.push(['Custo ≥ R$ '+filters.minCusto, ()=>{document.getElementById('filterMinCusto').value='';filters.minCusto=null;renderAll();}]);
  box.innerHTML = tags.map(([label,_],i)=>`<span class="active-filter-tag" data-i="${i}">${label}<button>✕</button></span>`).join('');
  box.querySelectorAll('.active-filter-tag').forEach((el,i)=>{
    el.querySelector('button').addEventListener('click', tags[i][1]);
  });
}


/* ============================================================================
   6. BLOCO "KPIS GERAIS"
   4 cartões com ícone: Frotas na Seleção, Registros de Custo/Avaria,
   Ocorrências "Mau Uso" e Custo Total Acumulado. Todos recalculados a
   partir do array `data` já filtrado (recebido de renderAll()).
   ============================================================================ */
function renderKpis(data){
  const totalCusto = data.reduce((s,f)=>s+f.custo,0);
  // Se houver filtro de classificação ativo, conta só os registros daquela
  // classe; senão conta todos os registros de custo/avaria da frota.
  const totalReg   = data.reduce((s,f)=>s+ (filters.classe ? (f.classes[filters.classe]||0) : f.count), 0);
  const totalMau   = data.reduce((s,f)=>s+(f.classes['Mau uso']||0), 0);
  const totalPrev  = data.reduce((s,f)=>s+(f.classes['Preventiva']||0), 0);

  document.getElementById('kpiRow').innerHTML = `
    <div class="card kpi-card">
      <div class="kpi-icon"><svg viewBox="0 0 24 24"><rect x="1" y="7" width="13" height="9" rx="1.5"></rect><path d="M14 10h4l3 3.2v2.8h-7z"></path><circle cx="6.5" cy="18" r="1.6"></circle><circle cx="17.5" cy="18" r="1.6"></circle></svg></div>
      <div class="kpi-body">
        <div class="label">Frotas na Seleção Atual</div>
        <div class="big">${data.length}</div>
        <div class="delta">de ${fleet.length} frotas na base</div>
      </div>
    </div>
    <div class="card kpi-card">
      <div class="kpi-icon"><svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17" rx="2"></rect><path d="M9 3h6v3H9z"></path><path d="M8 11.5h8M8 15.5h5"></path></svg></div>
      <div class="kpi-body">
        <div class="label">Registros de Custo/Avaria</div>
        <div class="big">${totalReg}</div>
        <div class="delta">no período Fev–Jul/2026</div>
      </div>
    </div>
    <div class="card kpi-card">
      <div class="kpi-icon"><svg viewBox="0 0 24 24"><path d="M12 3.5L21.5 20h-19z"></path><path d="M12 9.5v4.5"></path><circle cx="12" cy="17" r="0.9" fill="#fff" stroke="none"></circle></svg></div>
      <div class="kpi-body">
        <div class="label">Ocorrências "Mau Uso"</div>
        <div class="big">${totalMau}</div>
        <div class="delta">na seleção atual</div>
      </div>
    </div>
    <div class="card kpi-card">
      <div class="kpi-icon"><svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="2.5"></rect><path d="M2 10.5h20"></path><circle cx="17" cy="15" r="1.3" fill="#fff" stroke="none"></circle></svg></div>
      <div class="kpi-body">
        <div class="label">Custo Total Acumulado</div>
        <div class="big" style="font-size:18px;">R$ ${fmtBRL(totalCusto)}</div>
        <div class="delta">${totalPrev} registros de preventiva inclusos</div>
      </div>
    </div>
  `;
}


/* ============================================================================
   7. HELPERS DE SVG
   Todos os gráficos deste dashboard são desenhados "na mão" com elementos
   SVG nativos (sem biblioteca externa como Chart.js) — decisão tomada para
   não depender de CDN externo. `svgEl` é um atalho para criar um elemento
   SVG com atributos já definidos.
   ============================================================================ */
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs){
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}


/* ============================================================================
   8. BLOCO "CUSTO TOTAL POR PERÍODO" — gráfico de linha/área
   Soma o campo `valor` do histórico de cada frota, agrupado por mês/ano,
   e desenha uma linha com preenchimento em gradiente. Cada ponto mostra o
   valor em R$ escrito acima dele (não só no hover) e uma bolinha branca
   com borda vermelha; passar o mouse ainda mostra o tooltip com o mês.
   Fonte dos dados: 3_0_-_Ajuste_da_base_de_Custo.xlsx (ver etl_frotas.py).
   ============================================================================ */
function renderCostChart(data){
  // 1) Agrupa o valor de cada registro de histórico por "AAAA-MM"
  const byMonth = {};
  data.forEach(f=>{
    filteredHist(f).forEach(h=>{
      const parts = h.data.split('/'); // h.data no formato dd/mm/aaaa
      if (parts.length!==3) return;
      const key = parts[2]+'-'+parts[1];
      byMonth[key] = (byMonth[key]||0) + h.valor;
    });
  });

  const labels = Object.keys(byMonth).sort();
  const monthNames = {'01':'jan','02':'fev','03':'mar','04':'abr','05':'mai','06':'jun',
                       '07':'jul','08':'ago','09':'set','10':'out','11':'nov','12':'dez'};
  const displayLabels = labels.map(l=>{ const [y,m]=l.split('-'); return monthNames[m]+'/'+y.slice(2); });
  const values = labels.map(l=>Math.round(byMonth[l]*100)/100);

  const wrap = document.getElementById('costChartWrap');
  wrap.innerHTML = '';
  if (values.length === 0){
    wrap.innerHTML = '<div class="footnote" style="padding:30px 0;text-align:center;">Nenhum dado para os filtros selecionados.</div>';
    return;
  }

  // 2) Configuração do "canvas" SVG e das funções de escala (dados → pixels)
  const W = 900, H = 380, padL = 70, padR = 20, padT = 50, padB = 34;
  const maxV = Math.max(...values) * 1.22 || 1; // 22% de folga acima do maior valor
  const stepX = (W - padL - padR) / Math.max(values.length - 1, 1);
  const xAt = i => padL + i * stepX;
  const yAt = v => padT + (H - padT - padB) * (1 - v / maxV);

  const svg = svgEl('svg', {viewBox:`0 0 ${W} ${H}`, style:'width:100%;height:auto;display:block;'});

  // 3) Gradiente de preenchimento da área sob a linha
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', {id:'areaGrad', x1:'0', y1:'0', x2:'0', y2:'1'});
  grad.appendChild(svgEl('stop', {offset:'0%',   'stop-color':'#ff5064', 'stop-opacity':'0.35'}));
  grad.appendChild(svgEl('stop', {offset:'100%', 'stop-color':'#ff5064', 'stop-opacity':'0.02'}));
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 4) Linhas de grade horizontais + rótulos do eixo Y (R$)
  for (let g=0; g<=4; g++){
    const v = maxV * g / 4;
    const y = yAt(v);
    svg.appendChild(svgEl('line', {x1:padL, x2:W-padR, y1:y, y2:y, stroke:'#eef0f6', 'stroke-width':1}));
    const t = svgEl('text', {x:padL-10, y:y+4, 'text-anchor':'end', 'font-size':12, fill:'#8890a0', 'font-family':'Inter,Arial,sans-serif'});
    t.textContent = 'R$ ' + Math.round(v).toLocaleString('pt-BR');
    svg.appendChild(t);
  }

  // 5) Área preenchida (polígono fechado do zero até a linha e de volta)
  let areaPath = `M ${xAt(0)} ${yAt(0)} `;
  values.forEach((v,i)=> areaPath += `L ${xAt(i)} ${yAt(v)} `);
  areaPath += `L ${xAt(values.length-1)} ${yAt(0)} Z`;
  svg.appendChild(svgEl('path', {d:areaPath, fill:'url(#areaGrad)', stroke:'none'}));

  // 6) Linha propriamente dita
  let linePath = values.map((v,i)=> (i===0?'M':'L') + ' ' + xAt(i) + ' ' + yAt(v)).join(' ');
  svg.appendChild(svgEl('path', {d:linePath, fill:'none', stroke:'#c8172f', 'stroke-width':3.5,
    'stroke-linecap':'round', 'stroke-linejoin':'round'}));

  // 7) Para cada ponto: valor em R$ escrito acima, bolinha, tooltip no
  //    hover, e o rótulo do mês no eixo X
  values.forEach((v,i)=>{
    const vt = svgEl('text', {x:xAt(i), y:yAt(v)-16, 'text-anchor':'middle', 'font-size':13, 'font-weight':700,
      fill:'#c8172f', 'font-family':'Poppins,Arial,sans-serif'});
    vt.textContent = 'R$ ' + Math.round(v).toLocaleString('pt-BR');
    svg.appendChild(vt);

    const c = svgEl('circle', {cx:xAt(i), cy:yAt(v), r:5.5, fill:'#fff', stroke:'#c8172f', 'stroke-width':3, class:'hoverable'});
    c.addEventListener('mousemove', e=> showTooltip(e, `${displayLabels[i]}: R$ ${fmtBRL(v)}`));
    c.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(c);

    const t = svgEl('text', {x:xAt(i), y:H-10, 'text-anchor':'middle', 'font-size':12.5, fill:'#7c8194', 'font-family':'Inter,Arial,sans-serif'});
    t.textContent = displayLabels[i];
    svg.appendChild(t);
  });

  wrap.appendChild(svg);
}


/* ============================================================================
   9. BLOCO "CAUSA RAIZ DAS AVARIAS" — donut de classificação
   Agrupa o histórico por CLASSIFICAÇÃO (Mau uso / Estrutura / Processo /
   Preventiva) — "Regularização" é sempre excluída aqui porque não é uma
   causa de avaria. O toggle "Ocorrências / Valor (R$)" troca `classMode`
   entre contar registros ou somar o campo `valor`.
   ============================================================================ */

// Soma (contagem ou valor, conforme `mode`) por classificação, ignorando "Regularização".
function computeClassAgg(data, mode){
  const agg = {};
  data.forEach(f=>{
    filteredHist(f).forEach(h=>{
      if (h.tipo === 'Regularização') return;
      agg[h.tipo] = (agg[h.tipo]||0) + (mode==='count' ? 1 : h.valor);
    });
  });
  return agg;
}

let classMode = 'count'; // 'count' (ocorrências) ou 'valor' (R$) — alterado pelo toggle

function renderClassChart(data){
  const agg = computeClassAgg(data, classMode);
  const wrap = document.getElementById('classChartWrap');
  wrap.innerHTML = '';
  const labels = Object.keys(agg);
  const total = labels.reduce((s,l)=>s+agg[l], 0);
  if (total === 0){
    wrap.innerHTML = '<div class="footnote" style="padding:30px 0;text-align:center;">Nenhuma avaria para os filtros selecionados.</div>';
    return;
  }

  // Desenha o anel do donut como uma série de arcos de círculo (um <circle>
  // por classificação, usando stroke-dasharray para simular cada "fatia").
  const cx=88, cy=95, r=64, sw=26;
  const svg = svgEl('svg', {viewBox:'0 0 320 190', style:'width:100%;height:auto;display:block;max-width:380px;'});
  let angleStart = -90; // começa no topo (12h)
  const circumference = 2*Math.PI*r;

  labels.forEach(label=>{
    const val = agg[label];
    const frac = val/total;
    const dash = circumference*frac;
    const gapDash = circumference - dash;
    const seg = svgEl('circle', {
      cx, cy, r, fill:'transparent', stroke:CLASS_COLORS[label]||'#999', 'stroke-width':sw, 'stroke-linecap':'round',
      'stroke-dasharray':`${Math.max(dash-3,0)} ${gapDash+3}`, // -3 cria um pequeno respiro entre fatias
      'stroke-dashoffset': -1*(angleStart+90)/360*circumference,
      transform:`rotate(-90 ${cx} ${cy})`, class:'hoverable'
    });
    const tooltipText = classMode==='count'
      ? `${label}: ${val} ocorrência(s) (${(frac*100).toFixed(0)}%)`
      : `${label}: R$ ${fmtBRL(val)} (${(frac*100).toFixed(0)}%)`;
    seg.addEventListener('mousemove', e=>showTooltip(e, tooltipText));
    seg.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(seg);
    angleStart += frac*360;
  });

  // Número grande no centro do donut (total geral)
  const ct = svgEl('text', {x:cx, y:cy-2, 'text-anchor':'middle', 'font-size':20, 'font-weight':700, fill:'#1f2233', 'font-family':'Poppins,Arial,sans-serif'});
  ct.textContent = classMode==='count' ? total : 'R$ '+Math.round(total).toLocaleString('pt-BR');
  svg.appendChild(ct);
  const ct2 = svgEl('text', {x:cx, y:cy+16, 'text-anchor':'middle', 'font-size':11, fill:'#7c8194', 'font-family':'Inter,Arial,sans-serif'});
  ct2.textContent = classMode==='count' ? 'ocorrências' : 'no total';
  svg.appendChild(ct2);

  // Legenda à direita do donut (cor + nome + porcentagem)
  labels.forEach((label,i)=>{
    const ly = 26 + i*30;
    svg.appendChild(svgEl('rect', {x:195, y:ly, width:13, height:13, rx:4, fill:CLASS_COLORS[label]||'#999'}));
    const lt = svgEl('text', {x:215, y:ly+11, 'font-size':13, fill:'#1f2233', 'font-family':'Inter,Arial,sans-serif', 'font-weight':600});
    const pct = ((agg[label]/total)*100).toFixed(0);
    lt.textContent = `${label} — ${pct}%`;
    svg.appendChild(lt);
  });

  wrap.appendChild(svg);
}

// Clique nos botões "Ocorrências" / "Valor (R$)": troca o modo do donut e
// redesenha só ele (não precisa recalcular o resto do dashboard).
document.querySelectorAll('.toggle-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    btn.parentElement.querySelectorAll('.toggle-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    classMode = btn.dataset.mode;
    renderClassChart(applyFilters(fleet));
  });
});


/* ============================================================================
   10. BLOCO "CAUSA RAIZ DAS AVARIAS" — rankings
   Duas listas ao lado do donut:
     - "Peças que Mais Quebram": conta ocorrências por MATERIAL (qualquer
       classificação, incluindo Regularização — é um ranking de peças, não
       de causa de avaria).
     - "Frotas com Mais Avarias por Mau Uso": conta, por frota, quantos
       registros de histórico têm classificação exatamente "Mau uso".
   Cada linha mostra uma barrinha proporcional ao maior valor da lista.
   ============================================================================ */
function renderRankings(data){
  const materialCount = {};
  const mauUsoByFrota = {};

  data.forEach(f=>{
    filteredHist(f).forEach(h=>{
      if (h.material) materialCount[h.material] = (materialCount[h.material]||0)+1;
      if (h.tipo === 'Mau uso') mauUsoByFrota[f.frota] = (mauUsoByFrota[f.frota]||0)+1;
    });
  });

  // Top 6 peças por número de ocorrências
  const topMat = Object.entries(materialCount).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxMat = topMat[0]?.[1] || 1;
  document.getElementById('rankMaterial').innerHTML = topMat.length ? topMat.map(([name,val])=>`
    <div class="rank-row">
      <div style="flex:1">
        <div class="name">${name.length>38? name.slice(0,38)+'…': name}</div>
        <div class="bar-mini" style="width:${(val/maxMat*100).toFixed(0)}%"></div>
      </div>
      <div class="val">${val}</div>
    </div>`).join('') : '<div class="footnote">Sem dados para os filtros atuais.</div>';

  // Top 6 frotas com mais ocorrências de "Mau uso"
  const topFrotas = Object.entries(mauUsoByFrota).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxF = topFrotas[0]?.[1] || 1;
  document.getElementById('rankMauUso').innerHTML = topFrotas.length ? topFrotas.map(([f,val])=>`
    <div class="rank-row">
      <div style="flex:1">
        <div class="name">Frota ${f}</div>
        <div class="bar-mini" style="width:${(val/maxF*100).toFixed(0)}%"></div>
      </div>
      <div class="val">${val}</div>
    </div>`).join('') : '<div class="footnote">Sem dados para os filtros atuais.</div>';
}


/* ============================================================================
   11. BLOCO "PREVENTIVA X CORRETIVA" — tabela de frotas
   Tabela ordenável (clique no cabeçalho) e filtrável, com uma bolinha ●
   verde ao lado do código da frota quando o status de preventiva daquela
   linha é REAL (cruzado com Preventiva_-_Gru.csv) e não um placeholder.
   ============================================================================ */

// Ordena a lista já filtrada de acordo com sortKey/sortDir (estado global,
// alterado pelos cliques no cabeçalho — ver seção 13).
function sortedFleet(data){
  const copy = data.slice().sort((a,b)=>{
    let va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb||'').toLowerCase(); }
    if (va < vb) return -1*sortDir;
    if (va > vb) return  1*sortDir;
    return 0;
  });
  return copy;
}

function renderFleetTable(data){
  const sorted = sortedFleet(data);
  document.getElementById('rowCount').textContent = sorted.length;
  const body = document.getElementById('fleetTableBody');
  body.innerHTML = '';

  if (sorted.length === 0){
    body.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhuma frota corresponde aos filtros selecionados.</td></tr>';
    return;
  }

  sorted.forEach(f=>{
    const tr = document.createElement('tr');
    if (activeIdx === f.frota) tr.classList.add('active'); // realça a linha da frota aberta no painel de detalhe
    tr.innerHTML = `
      <td><b>${f.frota}</b>${f.hasRealPreventiva ? ' <span title="Status real cruzado com Preventiva_-_Gru.csv" style="color:#1f7a2c;">●</span>' : ''}</td>
      <td>${f.modeloDisplay}</td>
      <td>${f.marcaDisplay}</td>
      <td><span class="dot ${f.status}"></span><span class="status-text ${f.status}">${statusLabel[f.status]}</span></td>
      <td>${f.count}</td>
      <td>R$ ${fmtBRL(f.custo)}</td>
    `;
    tr.addEventListener('click', ()=>openDetail(f, tr)); // abre o painel de detalhe (seção 12)
    body.appendChild(tr);
  });
}


/* ============================================================================
   12. PAINEL DE DETALHE DA FROTA
   Mostrado dentro do painel de KPIs (ao lado da tabela). Por padrão exibe
   a frota de maior custo acumulado (chamado 1x na inicialização, seção 17);
   ao clicar numa linha da tabela, atualiza para a frota clicada.
   ============================================================================ */
function openDetail(f, tr){
  activeIdx = f.frota;
  if (tr){
    document.querySelectorAll('#fleetTableBody tr').forEach(r=>r.classList.remove('active'));
    tr.classList.add('active');
  }

  // Cabeçalho: nome da frota + dados cadastrais (se existirem)
  document.getElementById('detFrota').textContent = 'Frota ' + f.frota;
  document.getElementById('detModelo').textContent =
    (f.modelo ? `${f.modelo} · ${f.marca||''} · ${f.ano||''} · Chassi ${f.chassi||'—'}` : 'Sem dados cadastrais vinculados nesta prévia');
  document.getElementById('detailHint').textContent = tr
    ? 'clique em outra linha na tabela para trocar de frota'
    : 'mostrando a frota de maior custo acumulado — clique em outra linha na tabela para ver os detalhes dela';

  // Mini-cards: custo acumulado, nº de registros, mau uso, preventiva, horímetro
  document.getElementById('detCusto').textContent = 'R$ ' + fmtBRL(f.custo);
  document.getElementById('detCount').textContent = f.count;
  document.getElementById('detMau').textContent   = f.classes['Mau uso']   || 0;
  document.getElementById('detPrev').textContent  = f.classes['Preventiva'] || 0;
  const cardHorimetro = document.getElementById('detHorimetro').closest('.mini-card');
  document.getElementById('detHorimetro').textContent = f.horimetroAtual
    ? `${f.horimetroAtual.valor.toLocaleString('pt-BR')} h (${f.horimetroAtual.data})`
    : 'sem leitura registrada';
  cardHorimetro.classList.toggle('nodata', !f.horimetroAtual);

  // Bloco de preventiva: só existe conteúdo real se o ETL conseguiu casar
  // o código desta frota com uma linha de Preventiva_-_Gru.csv (12 de 39).
  const pg = document.getElementById('detPrevGrid');
  if (f.preventiva){
    pg.innerHTML = `
      <div class="mini-card"><div class="k">Última Preventiva Realizada</div><div class="v">${f.preventiva.ultima_realizada_data||'—'} (${f.preventiva.ultima_realizada_sigla||''})</div></div>
      <div class="mini-card"><div class="k">Próximo Plano</div><div class="v">${f.preventiva.proxima_sigla||'—'}</div></div>
      <div class="mini-card"><div class="k">Vencimento (horímetro)</div><div class="v">${f.preventiva.proxima_vencimento_horimetro||'—'} h</div></div>
      <div class="mini-card"><div class="k">Desvio</div><div class="v">${f.preventiva.proxima_desvio>0?'+':''}${f.preventiva.proxima_desvio} h</div></div>
    `;
  } else {
    pg.innerHTML = `<div class="mini-card nodata" style="grid-column:1/-1;"><div class="k">Preventiva</div><div class="v">Sem dado real cruzado para esta frota em Preventiva_-_Gru.csv (código de frota não encontrado no relatório do SISMA).</div></div>`;
  }

  // Histórico recente de avarias/custo (mais novo primeiro, já vem assim do Python)
  document.getElementById('histBody').innerHTML = f.hist.map(h=>`
    <tr>
      <td>${h.data}</td>
      <td><span class="badge ${CLASS_BADGE[h.tipo]||''}">${h.tipo}</span></td>
      <td title="${(h.material||'').replace(/"/g,'&quot;')}">${h.material||''}</td>
      <td>R$ ${fmtBRL(h.valor)}</td>
    </tr>`).join('');
}


/* ============================================================================
   13. EVENTOS DE ORDENAÇÃO DA TABELA
   Clique em qualquer cabeçalho com data-key (Frota, Nº Registros, Custo...)
   ordena a tabela por essa coluna; clicar de novo inverte a direção.
   ============================================================================ */
document.querySelectorAll('thead th[data-key]').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.key;
    if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = -1; }
    document.querySelectorAll('thead th .arrow').forEach(a=>a.textContent='');
    th.querySelector('.arrow').textContent = sortDir===1 ? '▴' : '▾';
    renderFleetTable(applyFilters(fleet));
  });
});


/* ============================================================================
   14. EVENTOS DOS FILTROS
   Cada input/select da barra de filtros atualiza o objeto global `filters`
   e chama renderAll() para redesenhar TODO o dashboard de forma consistente.
   ============================================================================ */
document.getElementById('filterClass').addEventListener('change', e=>{ filters.classe = e.target.value; renderAll(); });
document.getElementById('filterStatus').addEventListener('change', e=>{ filters.status = e.target.value; renderAll(); });
document.getElementById('filterMinCusto').addEventListener('input', e=>{ filters.minCusto = e.target.value ? parseFloat(e.target.value) : null; renderAll(); });
document.getElementById('searchBox').addEventListener('input', e=>{ filters.search = e.target.value.trim().toLowerCase(); renderAll(); });
document.getElementById('clearFilters').addEventListener('click', ()=>{
  filters = { classe:'', status:'', minCusto:null, search:'' };
  document.getElementById('filterClass').value = '';
  document.getElementById('filterStatus').value = '';
  document.getElementById('filterMinCusto').value = '';
  document.getElementById('searchBox').value = '';
  renderAll();
});


/* ============================================================================
   15. EXPORTAÇÃO PARA CSV
   Gera um .csv com a BASE COMPLETA (todas as frotas x todo o histórico,
   independente do que estiver filtrado na tela no momento), incluindo os
   dados de preventiva cruzados. Usa BOM (\uFEFF) para o Excel abrir os
   acentos corretamente.
   ============================================================================ */
function toCSVValue(v){
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')){
    return '"' + s.replace(/"/g,'""') + '"';
  }
  return s;
}

document.getElementById('exportBtn').addEventListener('click', ()=>{
  const headers = ['Frota','Modelo','Marca','Ano','Chassi','Data','Classificacao','Material_Descricao','Valor',
                   'Ultima_Preventiva_Data','Ultima_Preventiva_Plano','Proximo_Plano','Proximo_Vencimento_Horimetro','Desvio_Horas'];
  const lines = [headers.join(',')];

  fleet.forEach(f=>{
    const p = f.preventiva || {};
    f.hist.forEach(h=>{
      const row = [
        f.frota, f.modeloDisplay, f.marcaDisplay, f.ano||'', f.chassi||'',
        h.data, h.tipo, h.material||'', h.valor,
        p.ultima_realizada_data||'', p.ultima_realizada_sigla||'',
        p.proxima_sigla||'', p.proxima_vencimento_horimetro||'', p.proxima_desvio!=null?p.proxima_desvio:''
      ];
      lines.push(row.map(toCSVValue).join(','));
    });
  });

  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'dashboard_frotas_base_completa.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});


/* ============================================================================
   16. renderAll() — "MAESTRO" DA RENDERIZAÇÃO
   Chamado sempre que qualquer filtro muda. Recalcula a lista filtrada UMA
   vez (applyFilters) e passa para todos os blocos, garantindo que KPIs,
   gráficos e tabela fiquem sempre consistentes entre si.
   Observação: o donut (renderClassChart) tem seu PRÓPRIO redesenho ao
   trocar o toggle Ocorrências/Valor (seção 9) sem precisar chamar renderAll().
   ============================================================================ */
function renderAll(){
  const data = applyFilters(fleet);
  renderActiveTags();   // chips de filtro ativo
  renderKpis(data);      // Bloco KPIs Gerais
  renderCostChart(data); // Bloco Custo Total por Período
  renderClassChart(data);// Bloco Causa Raiz — donut
  renderRankings(data);  // Bloco Causa Raiz — rankings
  renderFleetTable(data);// Bloco Preventiva x Corretiva — tabela
}


/* ============================================================================
   17. INICIALIZAÇÃO
   Roda uma única vez, ao carregar a página:
     1) seleciona por padrão a frota de maior custo acumulado no painel de detalhe
     2) faz a primeira renderização completa do dashboard
   ============================================================================ */
const topFrota = fleet.slice().sort((a,b)=>b.custo-a.custo)[0];
if (topFrota) { activeIdx = topFrota.frota; openDetail(topFrota, null); }

renderAll();