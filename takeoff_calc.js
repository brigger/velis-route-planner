/* ═════════════════════════════════════════════════════════════════════
   takeoff_calc.js — shared takeoff + landing distance calculations and
   SVG drawing. Used by velis_takeoff.html (full UI) and by
   velis_navplan.html (compact inline pictures on the print).
   ═════════════════════════════════════════════════════════════════════ */
(function(){
  "use strict";

  let pohPromise=null;
  function loadPOH(){
    if(!pohPromise) pohPromise=fetch('velis_electro_poh.json').then(r=>r.json());
    return pohPromise;
  }

  function lerp(a,b,t){return a+t*(b-a);}
  function bracket(pts,v){
    const c=Math.max(pts[0],Math.min(pts[pts.length-1],v));
    for(let i=0;i<pts.length-1;i++) if(c<=pts[i+1]) return {i,t:(c-pts[i])/(pts[i+1]-pts[i])};
    return {i:pts.length-2,t:1};
  }
  function interp2D(table,altPts,isaPts,alt,isaDev){
    const a=bracket(altPts,alt), d=bracket(isaPts,isaDev);
    return lerp(
      lerp(table[a.i][d.i],table[a.i][d.i+1],d.t),
      lerp(table[a.i+1][d.i],table[a.i+1][d.i+1],d.t),
      a.t
    );
  }
  function isaDevOf(alt,oat){return oat-(15-2*alt/1000);}

  function readState(){
    try{
      const raw=localStorage.getItem('velis_takeoff');
      const s=raw?JSON.parse(raw):{};
      return {
        alt:+(s.alt!=null?s.alt:1525),
        oat:+(s.oat!=null?s.oat:15),
        wind:+(s.wind!=null?s.wind:0),
        surface:s.surface||'asphalt',
        condition:s.condition||'dry',
        slope:+(s.slope!=null?s.slope:0)
      };
    }catch(e){return {alt:1525,oat:15,wind:0,surface:'asphalt',condition:'dry',slope:0};}
  }

  function computeTakeoff(POH, cond){
    const {alt,oat,wind,surface,condition,slope}=cond;
    const to=POH.takeoff;
    const isaDev=isaDevOf(alt,oat);
    const grTable=surface==='asphalt'?to.asphalt_ground_roll_m:to.grass_ground_roll_m;
    const obTable=surface==='asphalt'?to.asphalt_50ft_m:to.grass_50ft_m;
    const grSL=grTable[0];
    const baseGR=interp2D(grTable,to.altitude_ft,to.isa_dev_c,alt,isaDev);
    const baseOB=interp2D(obTable,to.altitude_ft,to.isa_dev_c,alt,isaDev);
    const dSL=bracket(to.isa_dev_c,isaDev);
    const baseSL_GR=lerp(grSL[dSL.i],grSL[dSL.i+1],dSL.t);

    let windFactor=1;
    if(wind>0) windFactor=1-(wind/12)*0.10;
    else if(wind<0){const tw=Math.min(Math.abs(wind),10);windFactor=1+(tw/2)*0.10;}
    const windGR=baseGR*windFactor, windOB=baseOB*windFactor;

    let wetFactor=1;
    if(surface==='grass'&&condition==='wet') wetFactor=1.18;
    const wetGR=windGR*wetFactor, wetOB=windOB;

    let slopeAdd=0;
    if(slope>0) slopeAdd=baseSL_GR*0.22*slope;
    else if(slope<0) slopeAdd=baseSL_GR*(-0.07)*Math.abs(slope);
    const gr=Math.max(0,wetGR+slopeAdd);
    const ob=Math.max(0,wetOB+slopeAdd);
    return {gr,ob,isaDev,baseGR,baseOB,windFactor,wetFactor,slopeAdd,windGR,windOB,wetGR,wetOB,baseSL_GR};
  }

  function computeLanding(POH, cond){
    const {alt,oat,wind,surface,condition,slope}=cond;
    const ld=POH.landing;
    const isaDev=isaDevOf(alt,oat);
    const grTable=surface==='asphalt'?ld.asphalt_ground_roll_m:ld.grass_ground_roll_m;
    const obTable=surface==='asphalt'?ld.asphalt_50ft_m:ld.grass_50ft_m;
    const baseGR=interp2D(grTable,ld.altitude_ft,ld.isa_dev_c,alt,isaDev);
    const baseOB=interp2D(obTable,ld.altitude_ft,ld.isa_dev_c,alt,isaDev);

    let windFactor=1;
    if(wind>0) windFactor=1-(wind/13)*0.10;
    else if(wind<0){const tw=Math.min(Math.abs(wind),10);windFactor=1+(tw/2)*0.10;}
    const windGR=baseGR*windFactor, windOB=baseOB*windFactor;

    let wetFactor=1;
    if(surface==='grass'&&condition==='wet') wetFactor=1.30;
    const wetGR=windGR*wetFactor, wetOB=windOB;

    let slopeAdd=0;
    if(slope<0) slopeAdd=baseGR*0.27*Math.abs(slope);
    else if(slope>0) slopeAdd=-baseGR*0.09*slope;
    const gr=Math.max(0,wetGR+slopeAdd);
    const ob=Math.max(0,wetOB+slopeAdd);
    return {gr,ob,isaDev,baseGR,baseOB,windFactor,wetFactor,slopeAdd,windGR,windOB,wetGR,wetOB};
  }

  function n0(v){return Math.round(v);}

  // Takeoff picture: ground roll + climb to 50 ft obstacle.
  // opts: {W,H,ML,MR,MT,MB,fontSize,compact}
  function drawTakeoff(svg, gr, total, opts){
    opts=opts||{};
    const W=opts.W||700, H=opts.H||160, ML=opts.ML||40, MR=opts.MR||40, MT=opts.MT||20, MB=opts.MB||30;
    const fs=opts.fontSize||9;
    const compact=!!opts.compact;
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const IW=W-ML-MR;
    const scale=IW/Math.max(total,1);
    const grW=gr*scale;
    const climbW=(total-gr)*scale;
    const runY=H-MB-20;
    const obstY=MT+20;
    const obstH=runY-obstY;

    let h='';
    // Runway
    h+=`<rect x="${ML}" y="${runY}" width="${IW}" height="3" fill="#ccc" rx="1"/>`;
    // Ground roll bar
    h+=`<rect x="${ML}" y="${runY-4}" width="${grW}" height="6" fill="#185FA5" rx="2" opacity="0.7"/>`;
    if(grW>60){
      h+=`<line x1="${ML}" y1="${runY+16}" x2="${ML+grW}" y2="${runY+16}" stroke="#185FA5" stroke-width="1"/>`;
      h+=`<polygon points="${ML},${runY+13} ${ML+6},${runY+16} ${ML},${runY+19}" fill="#185FA5"/>`;
      h+=`<polygon points="${ML+grW},${runY+13} ${ML+grW-6},${runY+16} ${ML+grW},${runY+19}" fill="#185FA5"/>`;
      h+=`<text x="${ML+grW/2}" y="${runY+28}" font-size="${fs}" fill="#185FA5" text-anchor="middle" font-weight="600">Ground Roll: ${n0(gr)} m</text>`;
    }
    // Climb path
    const liftX=ML+grW;
    const obstX=ML+grW+climbW;
    const cpX=liftX+(obstX-liftX)*0.5;
    const cpY=runY-(obstH*0.3);
    h+=`<path d="M${liftX},${runY} Q${cpX},${cpY} ${obstX},${obstY}" fill="none" stroke="#3B6D11" stroke-width="2"/>`;
    // 50 ft line
    h+=`<line x1="${obstX}" y1="${runY}" x2="${obstX}" y2="${obstY}" stroke="#EF9F27" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    h+=`<text x="${obstX+8}" y="${obstY+obstH/2+4}" font-size="${fs}" fill="#EF9F27" font-weight="600">50 ft</text>`;
    // Total arrow
    h+=`<line x1="${ML}" y1="${MT+6}" x2="${obstX}" y2="${MT+6}" stroke="#3B6D11" stroke-width="1"/>`;
    h+=`<polygon points="${ML},${MT+3} ${ML+6},${MT+6} ${ML},${MT+9}" fill="#3B6D11"/>`;
    h+=`<polygon points="${obstX},${MT+3} ${obstX-6},${MT+6} ${obstX},${MT+9}" fill="#3B6D11"/>`;
    h+=`<text x="${(ML+obstX)/2}" y="${MT}" font-size="${fs}" fill="#3B6D11" text-anchor="middle" font-weight="600">Distance to clear 50 ft: ${n0(total)} m</text>`;
    if(!compact){
      h+=`<text x="${ML}" y="${runY-10}" font-size="${fs-1}" fill="#6b6660" text-anchor="middle">V = 0</text>`;
      h+=`<text x="${liftX}" y="${runY-10}" font-size="${fs-1}" fill="#185FA5" text-anchor="middle" font-weight="500">Lift off</text>`;
      h+=`<text x="${obstX}" y="${runY-10}" font-size="${fs-1}" fill="#EF9F27" text-anchor="middle" font-weight="500">Obstacle</text>`;
    }
    h+=`<circle cx="${ML}" cy="${runY}" r="4" fill="#185FA5"/>`;
    h+=`<circle cx="${liftX}" cy="${runY}" r="4" fill="#185FA5"/>`;
    h+=`<circle cx="${obstX}" cy="${obstY}" r="4" fill="#3B6D11"/>`;
    svg.innerHTML=h;
  }

  // Landing picture: descent from 50 ft obstacle + ground roll.
  function drawLanding(svg, gr, total, opts){
    opts=opts||{};
    const W=opts.W||700, H=opts.H||160, ML=opts.ML||40, MR=opts.MR||40, MT=opts.MT||20, MB=opts.MB||30;
    const fs=opts.fontSize||9;
    const compact=!!opts.compact;
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const IW=W-ML-MR;
    const scale=IW/Math.max(total,1);
    const grW=gr*scale;
    const appW=(total-gr)*scale;
    const runY=H-MB-20;
    const obstY=MT+20;

    let h='';
    h+=`<rect x="${ML}" y="${runY}" width="${IW}" height="3" fill="#ccc" rx="1"/>`;
    const obstX=ML+appW;
    const stopX=ML+appW+grW;
    const cpX=ML+(obstX-ML)*0.5;
    const cpY=runY-(runY-obstY)*0.3;
    h+=`<path d="M${ML},${obstY} Q${cpX},${cpY} ${obstX},${runY}" fill="none" stroke="#534AB7" stroke-width="2"/>`;
    h+=`<rect x="${obstX}" y="${runY-4}" width="${grW}" height="6" fill="#534AB7" rx="2" opacity="0.7"/>`;
    h+=`<line x1="${ML}" y1="${runY}" x2="${ML}" y2="${obstY}" stroke="#EF9F27" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    h+=`<text x="${ML-8}" y="${obstY+(runY-obstY)/2+4}" font-size="${fs}" fill="#EF9F27" font-weight="600" text-anchor="end">50 ft</text>`;
    if(grW>50){
      h+=`<line x1="${obstX}" y1="${runY+16}" x2="${stopX}" y2="${runY+16}" stroke="#534AB7" stroke-width="1"/>`;
      h+=`<polygon points="${obstX},${runY+13} ${obstX+6},${runY+16} ${obstX},${runY+19}" fill="#534AB7"/>`;
      h+=`<polygon points="${stopX},${runY+13} ${stopX-6},${runY+16} ${stopX},${runY+19}" fill="#534AB7"/>`;
      h+=`<text x="${obstX+grW/2}" y="${runY+28}" font-size="${fs}" fill="#534AB7" text-anchor="middle" font-weight="600">Ground Roll: ${n0(gr)} m</text>`;
    }
    h+=`<line x1="${ML}" y1="${MT+6}" x2="${stopX}" y2="${MT+6}" stroke="#3B6D11" stroke-width="1"/>`;
    h+=`<polygon points="${ML},${MT+3} ${ML+6},${MT+6} ${ML},${MT+9}" fill="#3B6D11"/>`;
    h+=`<polygon points="${stopX},${MT+3} ${stopX-6},${MT+6} ${stopX},${MT+9}" fill="#3B6D11"/>`;
    h+=`<text x="${(ML+stopX)/2}" y="${MT}" font-size="${fs}" fill="#3B6D11" text-anchor="middle" font-weight="600">Distance after clearing 50 ft: ${n0(total)} m</text>`;
    if(!compact){
      h+=`<text x="${ML}" y="${runY-10}" font-size="${fs-1}" fill="#EF9F27" text-anchor="middle" font-weight="500">Obstacle</text>`;
      h+=`<text x="${obstX}" y="${runY-10}" font-size="${fs-1}" fill="#534AB7" text-anchor="middle" font-weight="500">Touch down</text>`;
      h+=`<text x="${stopX}" y="${runY-10}" font-size="${fs-1}" fill="#6b6660" text-anchor="middle">V = 0</text>`;
    }
    h+=`<circle cx="${ML}" cy="${obstY}" r="4" fill="#EF9F27"/>`;
    h+=`<circle cx="${obstX}" cy="${runY}" r="4" fill="#534AB7"/>`;
    h+=`<circle cx="${stopX}" cy="${runY}" r="4" fill="#6b6660"/>`;
    svg.innerHTML=h;
  }

  window.takeoffCalc = {
    loadPOH, readState, computeTakeoff, computeLanding,
    drawTakeoff, drawLanding, isaDevOf, interp2D, bracket, lerp
  };
})();
