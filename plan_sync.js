/* ═════════════════════════════════════════════════════════════════════
   plan_sync.js — shared Save / Load / Save-as UI and bundle sync
   Loaded by every HTML page. Injects its own CSS, nav-bar status line,
   floating disc (FAB) + popup menu, and two modals (settings + plan
   list). Pages communicate via custom events `velis:before-save` and
   `velis:after-load`.
   ═════════════════════════════════════════════════════════════════════ */
(function(){
  "use strict";

  const API_BASE       = (typeof window!=='undefined'&&typeof window.VELIS_API_BASE==='string') ? window.VELIS_API_BASE : '/velis-planner/api';
  const AUTH_KEY       = 'velis_navplan_auth';
  const NAV_STATE_KEY  = 'velis_navplan_state';
  const MTIME_KEY      = 'velis_bundle_mtime';
  const STIME_KEY      = 'velis_bundle_stime';
  const BUNDLE_EXCLUDE = new Set([AUTH_KEY,'velis_navplan_view',MTIME_KEY,STIME_KEY]);

  /* ─── CSS ─── */
  const CSS = `
.plan-status-grow{flex:1 1 auto;}
.plan-status{font-size:11px;color:var(--tx2,#6b6660);padding:11px 60px 11px 10px;align-self:center;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px;font-family:var(--font,inherit);}
.plan-status .dot{width:6px;height:6px;border-radius:50%;background:#D46A1D;flex-shrink:0;display:none;}
.plan-status.dirty .dot{display:inline-block;}
.plan-status .name{color:var(--tx,#1a1a1a);font-weight:500;overflow:hidden;text-overflow:ellipsis;}
.plan-status .owner{color:var(--tx2,#6b6660);}
.plan-status .sep{color:var(--bd2,#ccc8c0);}

.plan-fab{position:fixed;top:14px;right:16px;width:44px;height:44px;border-radius:50%;border:1px solid var(--bd,#e2ddd6);background:var(--bg-card,#fff);color:var(--tx,#1a1a1a);cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.12),0 1px 3px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;z-index:200;padding:0;transition:transform 0.12s,box-shadow 0.12s;}
.plan-fab:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,0.16),0 2px 4px rgba(0,0,0,0.10);}
.plan-fab:active{transform:translateY(0);}
.plan-fab svg{width:22px;height:22px;opacity:0.85;pointer-events:none;}
.plan-fab .dot{position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:#D46A1D;border:2px solid var(--bg-card,#fff);display:none;}
.plan-fab.dirty .dot{display:block;}

.plan-menu{position:fixed;top:66px;right:16px;background:var(--bg-card,#fff);border:1px solid var(--bd,#e2ddd6);border-radius:var(--rad-md,8px);box-shadow:0 10px 30px rgba(0,0,0,0.18),0 2px 6px rgba(0,0,0,0.08);min-width:220px;padding:4px;z-index:201;display:none;font-family:var(--font,inherit);}
.plan-menu[data-open="1"]{display:block;}
.plan-menu button{display:flex;align-items:center;width:100%;min-height:44px;padding:10px 14px;border:none;background:transparent;font-family:inherit;font-size:13px;color:var(--tx,#1a1a1a);text-align:left;cursor:pointer;border-radius:6px;gap:8px;}
.plan-menu button:hover{background:var(--bg-sec,#f5f4f1);}
.plan-menu button:disabled{opacity:0.45;cursor:not-allowed;}
.plan-menu .sep{height:1px;background:var(--bd,#e2ddd6);margin:4px 6px;}
.plan-menu .kbd{margin-left:auto;font-size:10.5px;color:var(--tx2,#6b6660);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}

.plan-modal{position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:300;font-family:var(--font,inherit);}
.plan-modal[hidden]{display:none;}
.plan-modal-box{background:#fff;border-radius:var(--rad-lg,14px);padding:20px 24px;min-width:340px;max-width:520px;max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,0.2);}
.plan-modal-box h3{margin:0 0 14px;font-size:14px;font-weight:700;letter-spacing:-0.01em;}
.plan-modal-box label{display:block;font-size:10.5px;color:var(--tx2,#6b6660);font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:12px;}
.plan-modal-box label input{display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--bd2,#ccc8c0);border-radius:6px;font-size:14px;color:var(--tx,#1a1a1a);font-weight:400;text-transform:none;letter-spacing:0;background:#fff;box-sizing:border-box;}
.plan-modal-box .hint{font-size:10.5px;color:var(--tx2,#6b6660);margin:-6px 0 14px;font-style:italic;line-height:1.4;}
.plan-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}
.plan-modal-actions button{font-family:inherit;font-size:12px;font-weight:600;padding:8px 16px;min-height:36px;border:1px solid var(--bd,#e2ddd6);border-radius:6px;background:var(--bg-sec,#f5f4f1);color:var(--tx2,#6b6660);cursor:pointer;}
.plan-modal-actions button.primary{border-color:var(--blue,#185FA5);background:var(--blue,#185FA5);color:#fff;}
.plan-modal-actions button.primary:hover{background:#124a82;}

.plan-list{display:flex;flex-direction:column;gap:2px;margin:4px 0;}
.plan-li{display:flex;align-items:center;justify-content:space-between;padding:12px 10px;border-radius:6px;cursor:pointer;font-size:13px;gap:12px;min-height:44px;}
.plan-li:hover{background:var(--bg-sec,#f5f4f1);}
.plan-li .pn{font-weight:600;color:var(--tx,#1a1a1a);}
.plan-li .pd{font-size:11px;color:var(--tx2,#6b6660);margin-left:6px;}
.plan-li .del{border:none;background:transparent;color:#B08888;cursor:pointer;font-size:18px;padding:0 10px;line-height:1;min-width:32px;min-height:32px;}
.plan-li .del:hover{color:#791F1F;}
.plan-empty{font-size:12px;color:var(--tx2,#6b6660);padding:10px;font-style:italic;text-align:center;}

@media (max-width:700px){
  .nav-inner{flex-wrap:wrap;}
  .plan-status{order:10;flex-basis:100%;padding:0 12px 8px;max-width:none;}
}
@media print{
  .plan-fab,.plan-status,.plan-status-grow,.plan-menu,.plan-modal{display:none !important;}
}
`;

  /* ─── HTML fragments ─── */
  const STATUS_HTML = `<span class="plan-status-grow"></span><span class="plan-status" id="plan-status"></span>`;

  const FAB_HTML = `
<button class="plan-fab" id="plan-fab" type="button" aria-label="Plan actions" title="Plan (Save / Load)">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3h11l3 3v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M7 3v6h9V3"/><rect x="8" y="13" width="8" height="6" rx="1"/></svg>
  <span class="dot"></span>
</button>`;

  const MENU_HTML = `
<div class="plan-menu" id="plan-menu" role="menu">
  <button type="button" data-act="save">Save<span class="kbd">⌘S</span></button>
  <button type="button" data-act="save-as">Save as…</button>
  <button type="button" data-act="load">Load…</button>
  <div class="sep"></div>
  <button type="button" data-act="settings">API settings ⚙</button>
</div>`;

  const SETTINGS_HTML = `
<div class="plan-modal" id="plan-settings-modal" hidden>
  <div class="plan-modal-box">
    <h3>API settings</h3>
    <p class="hint">Shared API key (set once on the VPS) and your pilot label (used to scope saved plans).</p>
    <label>API key<input id="plan-set-key" type="password" autocomplete="off"></label>
    <label>Owner (short name)<input id="plan-set-owner" autocomplete="off" placeholder="e.g. patrick"></label>
    <div class="plan-modal-actions">
      <button type="button" id="plan-set-cancel">Cancel</button>
      <button type="button" id="plan-set-save" class="primary">Save</button>
    </div>
  </div>
</div>`;

  const LOAD_HTML = `
<div class="plan-modal" id="plan-load-modal" hidden>
  <div class="plan-modal-box">
    <h3>Load plan</h3>
    <div class="plan-list" id="plan-list"></div>
    <div class="plan-modal-actions">
      <button type="button" id="plan-load-cancel">Close</button>
    </div>
  </div>
</div>`;

  /* ─── Helpers ─── */
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function getAuth(){try{return JSON.parse(localStorage.getItem(AUTH_KEY))||{};}catch(e){return {};}}
  function setAuth(a){localStorage.setItem(AUTH_KEY,JSON.stringify(a));}

  async function api(path,opts={}){
    const auth=getAuth();
    const r=await fetch(API_BASE+path,{
      ...opts,
      headers:{
        'Content-Type':'application/json',
        'X-API-Key':auth.key||'',
        'X-Owner':auth.owner||'default',
        ...(opts.headers||{})
      }
    });
    if(!r.ok){
      const txt=await r.text().catch(()=>'');
      const err=new Error(r.status+' '+txt);
      err.status=r.status;
      throw err;
    }
    return r.json();
  }

  function ensureAuth(){
    const a=getAuth();
    if(!a.key||!a.owner){openSettings();return false;}
    return true;
  }

  /* ─── Dirty tracking ─── */
  function bundleDirty(){
    const m=parseInt(localStorage.getItem(MTIME_KEY)||'0',10);
    const s=parseInt(localStorage.getItem(STIME_KEY)||'0',10);
    return m>s;
  }
  function markBundleDirty(){localStorage.setItem(MTIME_KEY,String(Date.now()));repaint();}
  function markBundleSaved(){localStorage.setItem(STIME_KEY,String(Date.now()));repaint();}

  function currentMeta(){
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      if(!raw) return {id:null,name:''};
      const s=JSON.parse(raw);
      return (s&&s.meta)||{id:null,name:''};
    }catch(e){return {id:null,name:''};}
  }

  function updateStatus(){
    const el=document.getElementById('plan-status');
    if(!el) return;
    const meta=currentMeta();
    const auth=getAuth();
    const dirty=bundleDirty();
    let parts=[];
    parts.push('<span class="dot"></span>');
    if(meta.id){
      parts.push(`<span class="name">${esc(meta.name||('Plan #'+meta.id))}</span>`);
      parts.push(`<span>${dirty?'unsaved':'saved'}</span>`);
    } else {
      parts.push(`<span>${dirty?'Unsaved draft':'Not saved to server'}</span>`);
    }
    if(auth.owner){
      parts.push('<span class="sep">·</span>');
      parts.push(`<span class="owner">${esc(auth.owner)}</span>`);
    }
    el.innerHTML=parts.join('');
    el.classList.toggle('dirty',dirty);
  }

  function updateFabDirty(){
    const fab=document.getElementById('plan-fab');
    if(fab) fab.classList.toggle('dirty',bundleDirty());
  }
  function repaint(){updateStatus();updateFabDirty();}

  /* ─── Bundle I/O ─── */
  function collectBundle(){
    document.dispatchEvent(new CustomEvent('velis:before-save'));
    let navplan={};
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      if(raw){const {meta:_m,...rest}=JSON.parse(raw);navplan=rest;}
    }catch(e){}
    const ls={};
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith('velis_')&&!BUNDLE_EXCLUDE.has(k)) ls[k]=localStorage.getItem(k);
    }
    return {version:2,navplan,localStorage:ls};
  }
  function applyBundle(bundle){
    const ls=bundle&&bundle.localStorage;
    if(ls) for(const [k,v] of Object.entries(ls)) if(v!=null) localStorage.setItem(k,v);
    document.dispatchEvent(new CustomEvent('velis:after-load',{detail:{bundle}}));
  }

  /* ─── Actions ─── */
  async function doSave(){
    if(!ensureAuth()) return;
    const meta=currentMeta();
    if(!meta.id) return doSaveAs();
    try{
      await api(`/plans/${meta.id}`,{method:'PUT',body:JSON.stringify({plan_json:collectBundle()})});
      markBundleSaved();
    }catch(e){
      if(e.status===404){
        // Deleted server-side — clear the stale id and fall back to Save As
        persistMeta({id:null,name:meta.name});
        return doSaveAs();
      }
      alert('Save failed: '+e.message);
    }
  }
  async function doSaveAs(){
    if(!ensureAuth()) return;
    const meta=currentMeta();
    const suggested=meta.name||suggestedFromNavplan()||'';
    const name=prompt('Save as — plan name:',suggested);
    if(!name||!name.trim()) return;
    const bundle=collectBundle();
    try{
      const res=await api('/plans',{method:'POST',body:JSON.stringify({name:name.trim(),plan_json:bundle})});
      persistMeta({id:res.id,name:res.name});
      markBundleSaved();
    }catch(e){
      if(e.status===409){
        alert(`A plan named "${name.trim()}" already exists for this owner. Pick a different name.`);
        return doSaveAs();
      }
      alert('Save As failed: '+e.message);
    }
  }
  async function doLoad(){
    if(!ensureAuth()) return;
    const listEl=document.getElementById('plan-list');
    const modal=document.getElementById('plan-load-modal');
    listEl.innerHTML='<div class="plan-empty">Loading…</div>';
    modal.hidden=false;
    try{
      const plans=await api('/plans');
      if(!plans.length){
        listEl.innerHTML='<div class="plan-empty">No saved plans yet for this owner.</div>';
        return;
      }
      listEl.innerHTML=plans.map(p=>{
        const when=new Date(p.updated_at).toLocaleString();
        return `<div class="plan-li" data-id="${p.id}">
          <span><span class="pn">${esc(p.name)}</span><span class="pd">${esc(when)}</span></span>
          <button type="button" class="del" data-del="${p.id}" title="Delete">×</button>
        </div>`;
      }).join('');
    }catch(e){
      listEl.innerHTML=`<div class="plan-empty">Could not list plans: ${esc(e.message)}</div>`;
    }
  }

  function suggestedFromNavplan(){
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      if(!raw) return '';
      const s=JSON.parse(raw);
      return (s&&s.hdr&&s.hdr.ident)||'';
    }catch(e){return '';}
  }

  // Write meta back into velis_navplan_state (so Load flows survive pageshow)
  function persistMeta(meta){
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      const s=raw?JSON.parse(raw):{};
      s.meta={id:meta.id||null,name:meta.name||'',dirty:false};
      localStorage.setItem(NAV_STATE_KEY,JSON.stringify(s));
    }catch(e){}
  }

  /* ─── Modals ─── */
  function openSettings(){
    const a=getAuth();
    document.getElementById('plan-set-key').value=a.key||'';
    document.getElementById('plan-set-owner').value=a.owner||'';
    document.getElementById('plan-settings-modal').hidden=false;
  }
  function closeSettings(){document.getElementById('plan-settings-modal').hidden=true;}
  function closeLoadModal(){document.getElementById('plan-load-modal').hidden=true;}

  function wireSettingsModal(){
    document.getElementById('plan-set-cancel').addEventListener('click',closeSettings);
    document.getElementById('plan-set-save').addEventListener('click',()=>{
      const key=document.getElementById('plan-set-key').value.trim();
      const owner=document.getElementById('plan-set-owner').value.trim();
      if(!key||!owner){alert('Both API key and owner are required.');return;}
      setAuth({key,owner});
      closeSettings();
      repaint();
    });
  }
  function wireLoadModal(){
    document.getElementById('plan-load-cancel').addEventListener('click',closeLoadModal);
    document.getElementById('plan-list').addEventListener('click',async ev=>{
      const delBtn=ev.target.closest('[data-del]');
      if(delBtn){
        ev.stopPropagation();
        const pid=delBtn.dataset.del;
        if(!confirm('Delete this plan permanently?')) return;
        try{
          await api(`/plans/${pid}`,{method:'DELETE'});
          if(String(currentMeta().id)===String(pid)) persistMeta({id:null,name:''});
          doLoad();
        }catch(e){alert('Delete failed: '+e.message);}
        return;
      }
      const item=ev.target.closest('.plan-li');
      if(!item) return;
      const pid=item.dataset.id;
      try{
        const p=await api(`/plans/${pid}`);
        applyBundle(p.plan_json);
        persistMeta({id:p.id,name:p.name});
        markBundleSaved();
        closeLoadModal();
      }catch(e){alert('Load failed: '+e.message);}
    });
  }

  /* ─── FAB + menu ─── */
  function openMenu(){
    const m=document.getElementById('plan-menu');
    m.dataset.open='1';
    setTimeout(()=>document.addEventListener('click',onDocClickOnce,{once:true}),0);
  }
  function closeMenu(){document.getElementById('plan-menu').dataset.open='0';}
  function onDocClickOnce(ev){
    const m=document.getElementById('plan-menu');
    const f=document.getElementById('plan-fab');
    if(m && m.contains(ev.target)) return; // click inside menu → ignore (its own handler runs)
    if(f && f.contains(ev.target)) return; // click on FAB → its handler toggles
    closeMenu();
  }

  function wireFab(){
    document.getElementById('plan-fab').addEventListener('click',ev=>{
      ev.stopPropagation();
      const m=document.getElementById('plan-menu');
      if(m.dataset.open==='1') closeMenu(); else openMenu();
    });
  }
  function wireMenu(){
    document.getElementById('plan-menu').addEventListener('click',ev=>{
      const btn=ev.target.closest('button[data-act]');
      if(!btn) return;
      closeMenu();
      const act=btn.dataset.act;
      if(act==='save') doSave();
      else if(act==='save-as') doSaveAs();
      else if(act==='load') doLoad();
      else if(act==='settings') openSettings();
    });
  }
  function wireKeyboard(){
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='s'){
        e.preventDefault();
        doSave();
      }
      if(e.key==='Escape'){
        closeMenu();
        const s=document.getElementById('plan-settings-modal');if(s&&!s.hidden) closeSettings();
        const l=document.getElementById('plan-load-modal');if(l&&!l.hidden) closeLoadModal();
      }
    });
  }

  /* ─── DOM injection ─── */
  function injectCSS(){
    if(document.getElementById('plan-sync-css')) return;
    const s=document.createElement('style');
    s.id='plan-sync-css';
    s.textContent=CSS;
    document.head.appendChild(s);
  }
  function injectNavStatus(){
    const navInner=document.querySelector('.nav .nav-inner');
    if(!navInner||navInner.querySelector('#plan-status')) return;
    navInner.insertAdjacentHTML('beforeend',STATUS_HTML);
  }
  function injectFabAndModals(){
    if(document.getElementById('plan-fab')) return;
    document.body.insertAdjacentHTML('beforeend',FAB_HTML+MENU_HTML+SETTINGS_HTML+LOAD_HTML);
    wireFab();
    wireMenu();
    wireSettingsModal();
    wireLoadModal();
  }

  function boot(){
    injectCSS();
    injectNavStatus();
    injectFabAndModals();
    wireKeyboard();
    repaint();
    window.addEventListener('storage',e=>{
      if(!e.key||e.key.startsWith('velis_')) repaint();
    });
    window.addEventListener('pageshow',repaint);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();

  /* ─── Public API ─── */
  window.velisPlan = {
    save:doSave, saveAs:doSaveAs, load:doLoad, openSettings,
    markDirty:markBundleDirty, markSaved:markBundleSaved,
    bundleDirty, updateStatus:repaint
  };
})();
