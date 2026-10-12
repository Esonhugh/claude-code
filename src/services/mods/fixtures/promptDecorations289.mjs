// Pure official 2.1.289 functions only. L is an explicit number-dedup adapter; no CLI, Worker or native evidence.
let a;const L=values=>[...new Set(values)];
var $Q=(e,n)=>Math.max(0,Math.min(e,n));
function Sq({spans:e,edge:n,startIndex:r,offset:s}){let g=r;while(g<e.length&&(e[g]?.[n]??s)<=s)g+=1;return g};
var jit=(e)=>[...Array.from(va().segment(e),(n)=>n.index),e.length];
var oqn={black:"#000000",red:"#e5484d",green:"#46a758",yellow:"#f5d90a",blue:"#3e63dd",magenta:"#d6409f",cyan:"#05a2c2",white:"#ffffff",gray:"#8b8d98",grey:"#8b8d98",blackBright:"#6e6e6e",redBright:"#ff6369",greenBright:"#5bd07f",yellowBright:"#ffe629",blueBright:"#5b8def",magentaBright:"#ee6ac2",cyanBright:"#3ec2e0",whiteBright:"#ffffff"};
var rdn=(e)=>Object.hasOwn(oqn,e)?oqn[e]:void 0;
var WRe=(e)=>rdn(e)??e;
var zit=(e,n)=>V6t.every((r)=>e[r]===n[r]);
var qit=(e)=>!/[^\t\n\x20-\x7e]/.test(e);
function XRe(e,n,r){let s=r==="start",g=s?e>=n.end:e>n.end,h=s?e<n.start:e<=n.start;return g?e+n.inputText.length-(n.end-n.start):h?e:n.start+(s?n.inputText.length:0)};
var XTe=Object.freeze([]);
function VHo(e,n){let r=e.flatMap((s)=>{let g=XRe(s.start,n,"start"),h=XRe(s.end,n,"end");return h>g?[{...s,start:g,end:h}]:[]});return r.length===0?XTe:r};
var Kit=(e,n)=>({...e,...n.color!==void 0&&{color:WRe(n.color)},...n.backgroundColor!==void 0&&{backgroundColor:WRe(n.backgroundColor)},...n.dimColor!==void 0&&{dimColor:n.dimColor},...n.bold!==void 0&&{bold:n.bold},...n.italic!==void 0&&{italic:n.italic},...n.underline!==void 0&&{underline:n.underline},...n.strikethrough!==void 0&&{strikethrough:n.strikethrough}});
function ZRe(e,n){if(e===void 0)return n;let r=0,s=e.length;while(r<s){let g=Math.floor((r+s)/2),h=(e[g]??0)<=n;r=h?g+1:r,s=h?s:g}return e[r-1]??0};
function C_e(e,n){if(e===void 0||e.length===0)return XTe;let r=qit(n)?void 0:jit(n),s=e.flatMap((V,he)=>{let ye=ZRe(r,$Q(V.start,n.length)),ke=ZRe(r,$Q(V.end,n.length));return ke>ye?[{...V,start:ye,end:ke,order:he}]:[]}),g=s.toSorted((V,he)=>V.start-he.start),h=L(s.flatMap((V)=>[V.start,V.end])).toSorted((V,he)=>V-he),b=[],w=0,M=h.flatMap((V,he)=>{let ye=h[he-1]??V,ke=Sq({spans:g,edge:"start",startIndex:w,offset:ye});b=[...b,...g.slice(w,ke)].filter((Te)=>Te.end>ye),w=ke;let Se=ye===V||b.length===0,ve=b.toSorted((Te,xe)=>Te.order-xe.order).reduce(Kit,{});return Se?[]:[{start:ye,end:V,...ve}]}),B=M.flatMap((V,he)=>{let ye=M[he-1];return ye!==void 0&&ye.end===V.start&&zit(ye,V)?[]:[he]}),K=B.flatMap((V,he)=>{let ye=M[V],ke=M[(B[he+1]??M.length)-1];return ye!==void 0&&ke!==void 0?[{...ye,end:ke.end}]:[]});return K.length===0?XTe:K};
var V6t=["color","backgroundColor","dimColor","bold","italic","underline","strikethrough"];
function va(){if(!a)a=new Intl.Segmenter(void 0,{granularity:"grapheme"});return a};
export{C_e,VHo};
