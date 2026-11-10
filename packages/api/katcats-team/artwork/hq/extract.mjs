/** Extract the licensed HQ renderer without its simulator or external bridge. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = process.argv[2]
const headquarters = process.argv.includes('--headquarters')
if (!input) throw new Error('Usage: node extract.mjs <original index.html>')
const source = fs.readFileSync(input, 'utf8')
const template = source.match(/<template id="tpl-hq">([\s\S]*?)<\/template>/)?.[1]
if (!template) throw new Error('HQ template missing')
let script = source.slice(source.indexOf('function mountHQ(host, SR){'))
script = script.slice(0, script.indexOf('/* ================= 系列外壳'))
if (headquarters) {
  // Source releases use CRLF as well as LF.
  const normalized = script.replaceAll('\r\n', '\n')
  const start = normalized.indexOf('DEPTS.forEach(function (D, k) {\n  var R = D.R; D.seats = [];')
  const end = normalized.indexOf('var CHIEF_SEAT', start)
  if (start < 0 || end < 0) throw new Error('HQ seat construction missing')
  script = normalized.slice(0, start) + fs.readFileSync(path.join(here, 'headquarters-seats.js.txt'), 'utf8') + '\n' + normalized.slice(end)
}
const ast = ts.createSourceFile('hq.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const changes = []
const replacements = {
  updateSim: 'function updateSim(dt) { roomAnimate(dt); }',
  updatePanels: 'function updatePanels() {}',
  placeHud: 'function placeHud() { roomHud(); }',
  buildStaff: 'function buildStaff() {}', buildBottom: 'function buildBottom() {}',
  buildProjRows: 'function buildProjRows() {}', syncButtons: 'function syncButtons() {}',
  openTask: 'function openTask() {}', openHR: 'function openHR() {}',
  createTask: 'function createTask() { throw new Error("Read-only scene"); }',
  personAct: 'function personAct(p) { parent.postMessage({type:"katcats-room-member",id:p.botId}, "*"); }',
  onPick: 'function onPick(pk) { if (pk && pk.p) personAct(pk.p); }',
  act: 'function act(name) { if(name === "home" || name === "back") { goView("ov",0); resetView(); } }',
}
if (headquarters) {
  replacements.furnish = fs.readFileSync(path.join(here, 'headquarters-furnish.js.txt'), 'utf8')
  replacements.personAct = 'function personAct(p) { parent.postMessage({type:"headquarters-select",id:p.groupId || null,botId:p.botId}, "*"); }'
  replacements.onPick = 'function onPick(pk) { if (pk && pk.p) personAct(pk.p); else if(pk && pk.d !== undefined) headquartersSelect(pk.d); else if(pk && pk.chief && CHIEF) personAct(CHIEF); }'
}
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && replacements[node.name.text]) {
    changes.push([node.getStart(ast), node.end, replacements[node.name.text]])
    return
  }
  if (ts.isExpressionStatement(node) && /^\(function (initRoster|warmStart)\(/.test(node.getText(ast))) {
    changes.push([node.getStart(ast), node.end, ''])
    return
  }
  ts.forEachChild(node, visit)
}
visit(ast)
for (const [start, end, replacement] of changes.sort((a,b) => b[0]-a[0])) script = script.slice(0,start)+replacement+script.slice(end)
const debugStart = script.indexOf('// 调试用：')
script = script.slice(0, debugStart) + fs.readFileSync(path.join(here, headquarters ? 'headquarters-adapter.js.txt' : 'adapter.js.txt'), 'utf8') + '\nrequestAnimationFrame(frame);\n}\n'
script = script.replace('L.narrow = L.w < 760 || L.w / L.h < 1.05;', 'L.narrow = false;')
// Scene-only embeds retain legible identity labels and use the released panel space.
script = script.replace('L.bs = Math.min(fr.width / 1920, fr.height / 1080) || 0.2;',
  'L.bs = Math.max(0.8, Math.min(1, fr.width / 1920, fr.height / 1080));')
script = script.replace('yaw: 0.24, pitch: 0.95, dist: 69',
  'yaw: 0.24, pitch: 0.95, dist: 69 * Math.max(1, (L.h / L.w) / (1080 / 1920))')
script = script.replace('yaw: 0, pitch: 1.42, dist: 63',
  'yaw: 0, pitch: 1.42, dist: 63 * Math.max(1, (L.h / L.w) / (1080 / 1920))')
// Pointer events can arrive before the first animation frame initializes the camera.
script = script.replace('function proj(p) {', 'function proj(p) { if (!VP) return null;')
script = script.replace('PEOPLE.forEach(drawPerson);', 'PEOPLE.forEach(drawPerson); roomLinks();')
if (headquarters) script = script.replace('if (p.isChief) M = m4mul(M, m4S(1.15));',
  'if (p.isChief) M = m4mul(M, m4S(1.15)); else if(p.hqScale) M = m4mul(M, m4S(p.hqScale));')
script = script.replace(/if \(!L.narrow\) \{ L.rx0 = L.frX \+ 330[\s\S]*?L.ry1 = L.h - 170; \}/,
  'L.rx0 = L.w > 800 ? L.w * 0.17 : 0; L.rx1 = L.w > 800 ? L.w * 0.76 : L.w; L.ry0 = L.w > 800 ? 90 : 0; L.ry1 = L.w > 800 ? L.h - 140 : L.h;')
// Inaccessible simulator declarations are pruned after replacing all entry points.
for (let pass = 0; pass < 12; pass++) {
  const tree = ts.createSourceFile('hq.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const counts = new Map()
  function count(node) { if (ts.isIdentifier(node)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1); ts.forEachChild(node, count) }
  count(tree)
  const unused = []
  function prune(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text !== 'mountHQ' && counts.get(node.name.text) === 1) {
      unused.push([node.getStart(tree),node.end]); return
    }
    ts.forEachChild(node,prune)
  }
  prune(tree)
  if (!unused.length) break
  for (const [start,end] of unused.sort((a,b)=>b[0]-a[0])) script = script.slice(0,start)+script.slice(end)
}
const styles = `<style>
html,body,#host{margin:0;width:100%;height:100%;overflow:hidden;background:#0c1018}
</style>`
const overrides = `<style>
.hd,.crumb,.tools,.bgl,.bgr,.dock,.mini,.mdl,.staff,.sidebar,.lab,.room-lab{display:none!important}
.labels{display:none!important}.tg .bar,.tg .bd{display:none!important}.tg{pointer-events:auto!important}
.tg[hidden]{display:none!important}
.sb{pointer-events:none}.tg .t1 b{font-weight:500}.fit{inset:0!important}.fit-in{width:100%!important;height:100%!important}
.room-info{position:fixed;z-index:100;box-sizing:border-box;width:260px;max-width:calc(100vw - 16px);max-height:240px;overflow:auto;padding:12px 14px;border:1px solid;border-radius:3px;background:rgba(12,16,24,.96);color:#f4ece0;font:12px/1.5 'Microsoft YaHei',sans-serif;pointer-events:auto;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 8px 24px #0006}
.room-info[hidden]{display:none}.room-info strong{font-size:13px;font-weight:500}.room-info p{margin:6px 0 0;color:#b9ad9c}.room-info p:last-child{color:#ffc46b}.tg:focus-visible{outline:1px solid #ffc46b;outline-offset:2px}
</style>`
const bootstrap = headquarters
  ? 'const host=document.getElementById("host");const sr=host.attachShadow({mode:"open"});sr.append(document.getElementById("scene").content.cloneNode(true));addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.type!=="headquarters-state")return;if(!host.headquartersPayload){host.headquartersPayload=e.data.payload;try{mountHQ(host,sr);host.applyRoom(e.data.payload)}catch(error){parent.postMessage({type:"katcats-room-error"},"*");console.error(error)}}});parent.postMessage({type:"headquarters-ready"},"*");'
  : 'const host=document.getElementById("host");const sr=host.attachShadow({mode:"open"});sr.append(document.getElementById("scene").content.cloneNode(true));try{mountHQ(host,sr)}catch(error){parent.postMessage({type:"katcats-room-error"},"*");console.error(error)}'
const doc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'">' + styles
  + '<div id="host"></div><template id="scene">'+template+overrides+'</template><script>'
  + script + '\n' + bootstrap + '<\/script>'
const output = path.join(here, '../../src/client/' + (headquarters ? 'headquarters-scene.generated.ts' : 'hq-scene.generated.ts'))
fs.writeFileSync(output, '/** HQ renderer adapted from Copyright (c) 2026 赛博老爸. See artwork/hq/LICENSE. Generated by artwork/hq/extract.mjs. */\nexport const hqSceneDocument = '+JSON.stringify(doc)+'\n')
fs.copyFileSync(path.join(path.dirname(input),'LICENSE'), path.join(here,'LICENSE'))
console.log(`Generated ${Buffer.byteLength(doc)} bytes`)
