var Co = "REPL",
  N5 = "Eval",
  Xmn = "Code";
function ja(o) {
  return o === Co || o === N5;
}
function $R(o) {
  if (o === Co) return !0;
  return le() && o === N5;
}
function Tce(o) {
  return le() && ja(o) ? Xmn : o;
}
export { Co, N5, Xmn, ja, $R, Tce };
