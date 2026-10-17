// Pure official289 exact-function fixture. No original module imports/initializers/auth/files/network.
function buildWellFormed(mode){
var a=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
var g=typeof String.prototype.toWellFormed==="function"?Function.prototype.call.bind(String.prototype.toWellFormed):void 0;
function $u(t){if(g)return g(t);return t.replace(a,"\uFFFD")}
if(mode==='fallback')g=undefined;return $u;
}
function buildCleaner($u){
var ae=/[^\t\n\x20-\x7e]/;
var O=/^\p{L}$/u;
var _=/^\p{M}$/u;
var fe=/^\p{White_Space}$/u;
var ue=/^[\p{Emoji}\p{Extended_Pictographic}]$/u;
var W=/^\p{Extended_Pictographic}$/u;
var ce=/^\p{Sm}$/u;
function G(e,n){let r=n.split(" ").map((i)=>`\\p{${e}=${i}}`).join("");return new RegExp(`^[${r}]$`,"u")}
function z(e){return{base:G("Script",e),mark:G("Script_Extensions",e)}}
function B(e){return{base:e,mark:e}}
var ee=/^[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]$/u;
var le=/^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Hanifi_Rohingya}]$/u;
var D=/^\p{Nd}$/u;
var X=z("Arabic Syriac Nko Mongolian Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan");
var pe=z("Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan Arabic Syriac Tifinagh");
var xe=z("Arabic Syriac Mongolian Nko");
var ne=/^[\p{Script=Khmer}\p{Script=Thai}\p{Script=Lao}\p{Script=Myanmar}]$/u;
var de=B(ne);
var Z=/^[0-9]$/;
var V=B(/^\p{Script=Mongolian}$/u);
var be=B(/^\p{Script=Khmer}$/u);
var H=B(/^\p{Script=Egyptian_Hieroglyphs}$/u);
var Y=B(/^\p{Script=Duployan}$/u);
var J=/^\p{Script=Brahmi}$/u;
var me=/^[\p{Script=Myanmar}\p{Script=Phags_Pa}\p{Script=Manichaean}]$/u;
function k(e){if(e<160)return e<32&&e!==9&&e!==10||e>=127;if(e<8192)return e===173||e===847||e===1564||e===4447||e===4448||e===6068||e===6069||e>=6155&&e<=6159;if(e<65536)return e>=8203&&e<=8207||e>=8232&&e<=8238||e>=8288&&e<=8303||e===12644||e>=65024&&e<=65039||e===65279||e===65440||e>=65520&&e<=65531;return e===69759||e>=78896&&e<=78911||e===94180||e>=113824&&e<=113827||e>=119155&&e<=119162||e>=917504&&e<=921599}
var ge=["gbeng","gbsct","gbwls"];
var re=5;
function K(e,n){let r="",i=n+re+1;for(let t=n+1;t<=i&&t<e.length;t++){let f=e[t].codePointAt(0)??0;if(f===917631)return ge.includes(r)?t:-1;if(f<917601||f>917626)return-1;r+=String.fromCharCode(f-917504)}return-1}
function Cpe(e){let n={tags:0,bidi:0,zeroWidth:0,selectors:0,other:0};if(!ae.test(e))return{text:e,removedTotal:0,removedByClass:n,keptConditional:0};let r=$u(e),i=[],t=0,f=r===e?0:Ee(e);n.other+=f;let s={ring:Array(I).fill(0),next:0,size:0,lastWasHidden:!1,keptConditional:0},g=0,m,C;for(let d=0;d<r.length;){let u=r.codePointAt(d),b=d+(u>65535?2:1);if(!k(u)){if(u===10)g=b,m=void 0,C=void 0;else if(u===127988){let A=Array.from(r.slice(d,d+2*(re+2))),x=K(A,0);if(x!==-1){R(s,u,!1),d=b;for(let N=1;N<=x;N++)R(s,A[N].codePointAt(0),!0),d+=A[N].length;continue}}R(s,u,!1),d=b;continue}if(v(u)){let A=u===13&&r.charCodeAt(b)===10;if(d>t)i.push(r.slice(t,d));if(t=b,!A)i.push(`
`),f++,n.other++,R(s,10,!1),g=b,m=void 0,C=void 0;d=b;continue}let p=b<r.length?r.codePointAt(b):void 0,c=T(s,0),{lastWasHidden:E}=s,l=!1;switch(u){case 8204:case 8205:{if(l=y(s,u===8204?X:pe),!l&&u===8205){let x=c;if(x!==void 0&&(x===65039||P(x))){if(x=T(s,1),x!==void 0&&(x===65039||P(x)))x=T(s,2)}l=c!==void 0&&c!==8205&&o(W,x)&&F(p,W)}if(!l&&c!==void 0&&!E)l=u===8204?L(p,X)&&!o(fe,c)&&!o(_,c):L(p,xe)&&!o(O,c)&&!o(D,c)&&!o(_,c);break}case 8203:{let A=te(s,de,!0),x=F(p,ne)&&!o(_,p);l=A&&(x||F(p,Z))||x&&M(s,Z);break}case 65038:case 65039:l=c!==void 0&&!E&&(c>=169&&o(ue,c)||Ce(c)&&p===8419);break;case 65024:case 65025:case 65026:l=c!==void 0&&!E&&(o(H.base,c)||u===65024&&(c>=8704&&c<=11007&&o(ce,c)||o(me,c)));break;case 8206:case 8207:case 1564:if(u===1564){if(C===void 0)C=U(le,r,g);l=C}else{if(m===void 0)m=U(ee,r,g);l=m}l=l&&!E&&(p===void 0||v(p)||!k(p)&&!o(_,p))&&!Se(s,p);break;case 847:l=M(s,_)||!E&&F(p,_);break;case 6068:case 6069:l=y(s,be);break;case 6155:case 6156:case 6157:case 6158:case 6159:l=y(s,V)||!E&&L(p,V);break;case 69759:l=M(s,J)&&F(p,J);break;default:if(u>=78896&&u<=78911)l=y(s,H)||!E&&L(p,H);else if(u>=113824&&u<=113827)l=y(s,Y)||!E&&L(p,Y)}if(l)R(s,u,!0);else{if(d>t)i.push(r.slice(t,d));t=b,f++,n[Ae(u)]++}d=b}let{keptConditional:h}=s;if(t===0)return{text:r,removedTotal:f,removedByClass:n,keptConditional:h};return i.push(r.slice(t)),{text:i.join(""),removedTotal:f,removedByClass:n,keptConditional:h}}
function o(e,n){return n!==void 0&&e.test(String.fromCodePoint(n))}
function j(e,n){return o(O,n)&&o(e,n)}
function U(e,n,r){for(let i=r;i<n.length;){let t=n.codePointAt(i);if(v(t))return!1;if((t>=1424&&t<=2303||t>=64285&&t<=65023||t>=65136&&t<=65279||t>=67584&&t<=69631||t>=124928&&t<=126975)&&j(e,t))return!0;i+=t>65535?2:1}return!1}
function Q(e){return e===1600||o(ee,e)}
function Se(e,n){let r=o(O,n);if(!r&&!o(D,n))return!1;for(let i=0;i<e.size;i++){let t=T(e,i);if(k(t))return!0;if(o(_,t))continue;return r?o(O,t)&&Q(t)===Q(n):o(D,t)}return e.size>=I}
function v(e){return e===10||e===11||e===12||e===13||e===133||e===8232||e===8233}
var I=16;
function R(e,n,r){if(e.ring[e.next]=n,e.next=(e.next+1)%I,e.size<I)e.size++;if(e.lastWasHidden=r,r)e.keptConditional++}
function T(e,n){if(n>=e.size)return;return e.ring[(e.next-1-n+2*I)%I]}
function M(e,n){return e.size>0&&!e.lastWasHidden&&o(n,T(e,0))}
function y(e,n){return te(e,n,!1)}
function te(e,n,r){if(e.lastWasHidden)return!1;for(let i=0;i<e.size;i++){let t=T(e,i);if(o(_,t)){if(!o(n.mark,t))return!1;continue}return r?o(n.base,t):j(n.base,t)}return!1}
function F(e,n){return e!==void 0&&!k(e)&&o(n,e)}
function L(e,n){return e!==void 0&&!k(e)&&j(n.base,e)}
function P(e){return e>=127995&&e<=127999}
function Ce(e){return e>=48&&e<=57||e===35||e===42}
function Ee(e){let n=0;for(let r=0;r<e.length;r++){let i=e.charCodeAt(r);if(i>=55296&&i<=56319){let t=e.charCodeAt(r+1);if(t>=56320&&t<=57343)r++;else n++}else if(i>=56320&&i<=57343)n++}return n}
function Ae(e){if(e>=917504&&e<=917631)return"tags";if(e===1564||e===8206||e===8207||e>=8234&&e<=8238||e>=8294&&e<=8297)return"bidi";if(e>=8203&&e<=8205||e===8288||e===65279)return"zeroWidth";if(e>=65024&&e<=65039||e>=917760&&e<=917999||e>=6155&&e<=6157||e===6159)return"selectors";return"other"}
return {Cpe};
}
function buildGate(input){
function Du(e,n){return e===null?n:e}
const state={remoteEvalFeatureValues:new Map(Object.entries(input.payload??{})),experimentDataByFeature:new Map(),pendingExposures:new Map(),loggedExposures:new Set(),deps:{isEnabled:()=>input.enabled??true,isDiskCacheReadableWhileDisabled:()=>input.diskReadable??false,readGlobalConfig:()=>input.diskThrows?(()=>{throw new Error("fixture disk failure")})():({cachedGrowthBookFeatures:input.disk??{}})}};
state.getEnvironmentOverrides=({getEnvironmentOverrides(){return null}}).getEnvironmentOverrides;
state.readConfigOverrides=({readConfigOverrides(){return}}).readConfigOverrides;
state.getFeatureValueWithSource=({getFeatureValueWithSource(e,n){let r=this.getEnvironmentOverrides();if(r&&e in r)return{value:r[e],source:"override"};let s=this.readConfigOverrides();if(s&&e in s)return{value:s[e],source:"override"};if(!this.deps.isEnabled()&&!this.deps.isDiskCacheReadableWhileDisabled())return{value:n,source:"disabled"};if(this.experimentDataByFeature.has(e))this.logExposureForFeature(e);let g=this.remoteEvalFeatureValues.get(e);if(g!==void 0)return{value:Du(g,n),source:"payload"};if(this.remoteEvalFeatureValues.size>0)return{value:n,source:"fallback"};try{let h=this.deps.readGlobalConfig(),b=h.cachedGrowthBookFeatures?.[e];if(b!==void 0)return this.recordDeferredExposure(e,h),{value:Du(b,n),source:"disk"}}catch{}return{value:n,source:"fallback"}}}).getFeatureValueWithSource;
state.recordDeferredExposure=({recordDeferredExposure(e,n){let r=n.cachedExperimentData?.[e];if(typeof r!=="object"||r===null||typeof r.experimentId!=="string"||typeof r.variationId!=="number"||!Ir(r.value,n.cachedGrowthBookFeatures?.[e]))return;this.pendingExposures.set(e,{experimentId:r.experimentId,variationId:r.variationId})}}).recordDeferredExposure;
// Exposure side effects are excluded from this pure fallback/disabled/payload/disk oracle.
const Ir=()=>{throw new Error("excluded experiment-metadata comparison reached")};state.logExposureForFeature=()=>{throw new Error("excluded experiment exposure reached")};
function Ne(){return state}
function io(e,n){return Ne().getFeatureValueWithSource(e,n)}
function k(e,n){return io(e,n).value}
return{k,state};
}
export function createOfficial289Fixture(input={}){
const wellFormed=buildWellFormed(input.wellFormed??"native");const {Cpe}=buildCleaner(wellFormed);const {k,state}=buildGate(input);
var $Q=(e,n)=>Math.max(0,Math.min(e,n));
function tCe(){return k("tengu_tranquil_cloud",!0)}
var Vit="\r\v\f\x85\u2028\u2029";
function Yit(e,n){let r=new Uint32Array(e.length+1),s=0,g=0;for(let h of e){let b=String.fromCodePoint(n.codePointAt(g)??0),w=g<n.length&&(h===b||b===`
`&&Vit.includes(h)||b==="\uFFFD"&&/^[\uD800-\uDFFF]$/.test(h));for(let M=0;M<h.length;M++)r[s+M]=w?g+M:g;s+=h.length,g+=w?b.length:0}return r[e.length]=g,r}
function Xit(e,n){let r=n===void 0;if(!tCe())return r?{text:e}:{text:e,decorations:n};let s=Cpe(e).text;if(r)return{text:s};if(s===e)return{text:s,decorations:n};let h=Yit(e,s),b=(w)=>h[$Q(w,e.length)]??s.length;return{text:s,decorations:n.map((w)=>({...w,start:b(w.start),end:b(w.end)}))}}
return{Cpe,Yit,Xit,tCe,flagSource:()=>state.getFeatureValueWithSource("tengu_tranquil_cloud",true)};
}
