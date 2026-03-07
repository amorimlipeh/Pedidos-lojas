import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import pdfParse from "pdf-parse";
import xlsx from "xlsx";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "pedidos-lojas-secret";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

function nowIso(){ return new Date().toISOString(); }
function num(v){
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function defaultStores(){
  const out = {};
  for(let i=1;i<=20;i++) out[String(i).padStart(2,"0")] = `Loja ${String(i).padStart(2,"0")}`;
  return out;
}
function ensureDb(){
  if(fs.existsSync(DB_FILE)) return;
  const adminPass = process.env.ADMIN_PASSWORD || "admin123";
  const db = {
    stores: defaultStores(),
    users: [{ username: "admin", password_hash: bcrypt.hashSync(adminPass, 10), role: "admin", created_at: nowIso() }],
    products: {},
    stock_imports: [],
    orders_by_store: {},
    shortages_by_store: {},
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function readDb(){ ensureDb(); return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
function writeDb(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function sanitizeUser(u){ return String(u||"").trim().toLowerCase(); }
function authRequired(req,res,next){
  try{
    const auth = req.headers.authorization || "";
    const [, token] = auth.split(" ");
    if(!token) return res.status(401).json({ error: "Token ausente" });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  }catch(e){ return res.status(401).json({ error: "Token inválido" }); }
}
function adminRequired(req,res,next){
  if(req.user?.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao admin" });
  next();
}
function ensureStore(db, storeId){
  if(!db.draft_orders_by_store) db.draft_orders_by_store = {};
  if(!db.order_history_by_store) db.order_history_by_store = {};
  if(!db.shortage_history_by_store) db.shortage_history_by_store = {};
  if(!db.draft_orders_by_store[storeId]) db.draft_orders_by_store[storeId] = [];
  if(!db.order_history_by_store[storeId]) db.order_history_by_store[storeId] = [];
  if(!db.shortage_history_by_store[storeId]) db.shortage_history_by_store[storeId] = [];
  if(!db.orders_by_store) db.orders_by_store = {};
  if(!db.shortages_by_store) db.shortages_by_store = {};
  if(!db.orders_by_store[storeId]) db.orders_by_store[storeId] = [];
  if(!db.shortages_by_store[storeId]) db.shortages_by_store[storeId] = [];
}
function codePrefix(code){ return String(code || "").trim().toUpperCase().slice(0,3); }
function upsertProduct(db, product){
  const code = String(product.code || "").trim().toUpperCase();
  if(!code) return;
  const prev = db.products[code] || { code, product: "", material: "", stock: 0, factor: 1, source: "" };
  db.products[code] = {
    code,
    product: String(product.product ?? prev.product ?? "").trim(),
    material: String(product.material ?? prev.material ?? "").trim(),
    stock: Number.isFinite(product.stock) ? product.stock : prev.stock,
    factor: Number.isFinite(product.factor) && product.factor > 0 ? product.factor : (prev.factor || 1),
    source: Array.from(new Set([prev.source, product.source].filter(Boolean))).join(" | "),
    updated_at: nowIso()
  };
}
function mergeByCode(items){
  const map = {};
  for(const item of items){
    const code = String(item.code || "").trim().toUpperCase();
    if(!code) continue;
    const prev = map[code];
    if(!prev){
      map[code] = { ...item, code, stock: num(item.stock), factor: num(item.factor) || 1 };
      continue;
    }
    map[code] = {
      ...prev,
      product: item.product || prev.product,
      material: item.material || prev.material,
      stock: Math.max(num(prev.stock), num(item.stock)),
      factor: prev.factor || item.factor || 1,
      source: Array.from(new Set([prev.source, item.source].filter(Boolean))).join(" | ")
    };
  }
  return Object.values(map);
}
function normalizeLine(line){ return String(line || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim(); }
function isQty(v){ return /^-?\d[\d.]*,\d+$/.test(String(v||"").trim()) || /^-?\d+(?:\.\d+)?$/.test(String(v||"").trim()); }

function parseSimplifiedPdf(text, source){
  const lines = String(text || "").replace(/\r/g,"").split("\n").map(normalizeLine).filter(Boolean);
  const products = [];
  for(let i=0;i<lines.length;i++){
    const line = lines[i];
    const m = line.match(/^\(([A-Z0-9]{4,10})\)$/i);
    if(!m) continue;
    const code = m[1].toUpperCase();
    let product = "";
    let qty = 0;
    let j = i + 1;
    while(j < lines.length && !product){
      const ln = lines[j];
      if (/^(produto|matéria do produto|qtde\. estoque|estoque simplificado|arquivo gerado)/i.test(ln)) { j++; continue; }
      if (ln.match(/^\([A-Z0-9]{4,10}\)$/i)) break;
      if (!isQty(ln)) product = ln;
      j++;
    }
    while(j < lines.length){
      const ln = lines[j];
      if (isQty(ln)) { qty = num(ln); break; }
      if (ln.match(/^\([A-Z0-9]{4,10}\)$/i)) break;
      j++;
    }
    if (product) products.push({ code, product, material: product, stock: qty, factor: 1, source });
  }
  return mergeByCode(products);
}
function parseOriginalPdf(text, source){
  const lines = String(text || "").replace(/\r/g,"").split("\n").map(normalizeLine).filter(Boolean);
  const products = [];
  for(const line of lines){
    if (/^(produto|grupo de estoque|peso|local:|grupo:|erp |pág:|1-jf comercio)/i.test(line)) continue;
    const m = line.match(/UN([A-Z0-9]{4,10})\s*-\s*(.+?)\s+1$/i);
    if (m) {
      const code = m[1].toUpperCase();
      const product = m[2].trim();
      const prefix = line.slice(0, m.index);
      const nums = (prefix.match(/\d[\d.,]*/g) || []).map(x => x.trim()).filter(Boolean);
      let stock = 0;
      if (nums.length >= 2) stock = num(nums[nums.length - 2]);
      else if (nums.length >= 1) stock = num(nums[nums.length - 1]);
      products.push({ code, product, material: product, stock, factor: 1, source });
    }
  }
  return mergeByCode(products);
}
function parseWorkbook(filePath, source){
  const wb = xlsx.readFile(filePath, { cellDates: false });
  const products = [];
  for (const sheet of wb.SheetNames) {
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: "" });
    for (const row of rows) {
      const first = String(row[0] || "").trim();
      const m = first.match(/^([A-Z0-9]{4,10})\s*-\s*(.+)$/i);
      if (!m) continue;
      const code = m[1].toUpperCase();
      const product = m[2].trim();
      const stock = Number(row[2] || 0);
      products.push({ code, product, material: product, stock, factor: 1, source });
    }
  }
  return mergeByCode(products);
}
async function parseFile(file){
  const ext = path.extname(file.originalname || "").toLowerCase();
  const source = file.originalname || "arquivo";
  if(ext === ".pdf"){
    const data = await pdfParse(fs.readFileSync(file.path));
    const text = data.text || "";
    if (/Estoque Simplificado/i.test(text) || /\(\w{4,10}\)\s*\n/i.test(text)) return { imported_type: "pdf-simplificado", products: parseSimplifiedPdf(text, source) };
    return { imported_type: "pdf-original", products: parseOriginalPdf(text, source) };
  }
  if(ext === ".xlsx" || ext === ".xls") return { imported_type: "excel", products: parseWorkbook(file.path, source) };
  if(ext === ".docx"){
    const result = await mammoth.extractRawText({ path: file.path });
    return { imported_type: "word", products: parseSimplifiedPdf(result.value, source) };
  }
  if(ext === ".csv" || ext === ".txt"){
    const txt = fs.readFileSync(file.path, "utf8");
    return { imported_type: ext.slice(1), products: parseSimplifiedPdf(txt, source) };
  }
  if(ext === ".doc") throw new Error("Arquivo .doc antigo não é suportado diretamente. Salve como .docx.");
  throw new Error("Formato não suportado. Use PDF, XLSX, XLS, DOCX, CSV ou TXT.");
}
function normalizeOrderItems(items, db){
  return (Array.isArray(items) ? items : []).map(x => {
    const code = String(x.code || "").trim().toUpperCase();
    const productDb = db.products[code] || {};
    const factor = Math.max(1, num(x.factor) || num(productDb.factor) || 1);
    const units = num(x.units);
    const boxes = x.boxes !== undefined ? num(x.boxes) : (factor ? units / factor : 0);
    const stock = productDb.stock !== undefined ? num(productDb.stock) : num(x.stock);
    return {
      code,
      product: String(x.product || productDb.product || "").trim(),
      factor,
      boxes,
      units,
      stock,
      insufficient: units > stock
    };
  });
}
function nextOrderNumber(db, storeId){
  ensureStore(db, storeId);
  const list = db.order_history_by_store[storeId] || [];
  const max = list.reduce((m,x)=> Math.max(m, Number(String(x.order_number||'').replace(/\D/g,''))||0), 0);
  return `${String(storeId).padStart(2,'0')}-${String(max+1).padStart(4,'0')}`;
}
function getOrderRecord(db, storeId, orderNumber){ ensureStore(db, storeId); return (db.order_history_by_store[storeId]||[]).find(x=>x.order_number===orderNumber); }
function getShortageRecord(db, storeId, orderNumber){ ensureStore(db, storeId); return (db.shortage_history_by_store[storeId]||[]).find(x=>x.order_number===orderNumber); }
function orderExportRows(db, storeId, orderNumber){
  ensureStore(db, storeId);
  const record = getOrderRecord(db, storeId, orderNumber);
  const items = normalizeOrderItems(record?.items || [], db);
  return items.map((item, index) => ({
    Item: index + 1,
    Código: item.code,
    Produto: item.product,
    Caixas: item.boxes,
    Unidades: item.units,
    Estoque: item.stock,
    Fator: item.factor,
    Status: item.insufficient ? "Estoque inferior" : "OK"
  }));
}

app.use((req,res,next)=>{
  const db = readDb();
  let changed = false;
  for(const storeId of Object.keys(db.orders_by_store || {})){
    ensureStore(db, storeId);
    if((db.orders_by_store[storeId]||[]).length && !(db.draft_orders_by_store[storeId]||[]).length){ db.draft_orders_by_store[storeId]=db.orders_by_store[storeId]; changed = true; }
    if((db.shortages_by_store[storeId]||[]).length && !(db.shortage_history_by_store[storeId]||[]).length && (db.order_history_by_store[storeId]||[]).length){
      const last = db.order_history_by_store[storeId][0];
      db.shortage_history_by_store[storeId]=[{ order_number:last.order_number, created_at:last.created_at, items: db.shortages_by_store[storeId] }];
      changed = true;
    }
  }
  if(changed) writeDb(db);
  next();
});

app.get("/api/ping", (req,res)=> res.json({ status: "ok", time: nowIso() }));
app.get("/", (req,res)=> res.sendFile(path.join(__dirname, "index.html")));

app.post("/api/auth/login", (req,res)=>{
  const username = sanitizeUser(req.body.username);
  const password = String(req.body.password || "");
  const db = readDb();
  const user = db.users.find(u => u.username === username);
  if(!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: "Usuário ou senha inválidos" });
  const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, username: user.username, role: user.role });
});

app.get("/api/stores", authRequired, (req,res)=>{
  const db = readDb();
  res.json({ stores: db.stores });
});

app.get("/api/products", authRequired, (req,res)=>{
  const db = readDb();
  let items = Object.values(db.products || {});
  const q = String(req.query.q || "").trim().toLowerCase();
  if(q) items = items.filter(p => [p.code,p.product,p.material,p.source].join(" ").toLowerCase().includes(q));
  items.sort((a,b)=> String(a.code).localeCompare(String(b.code)));
  res.json({ products: items });
});

app.post("/api/products", authRequired, adminRequired, (req,res)=>{
  const db = readDb();
  const code = String(req.body.code || "").trim().toUpperCase();
  if(!code) return res.status(400).json({ error: "Código obrigatório" });
  upsertProduct(db, {
    code,
    product: String(req.body.product || "").trim(),
    material: String(req.body.material || "").trim(),
    stock: num(req.body.stock),
    factor: Math.max(1, num(req.body.factor) || 1),
    source: "manual"
  });
  writeDb(db);
  res.json({ ok: true, product: db.products[code] });
});

app.put("/api/products/:code", authRequired, adminRequired, (req,res)=>{
  const db = readDb();
  const code = String(req.params.code || "").trim().toUpperCase();
  if(!db.products[code]) return res.status(404).json({ error: "Produto não encontrado" });

  upsertProduct(db, {
    code,
    product: req.body.product ?? db.products[code].product,
    material: req.body.material ?? db.products[code].material,
    stock: req.body.stock !== undefined ? num(req.body.stock) : db.products[code].stock,
    factor: req.body.factor !== undefined ? Math.max(1, num(req.body.factor) || 1) : db.products[code].factor,
    source: db.products[code].source
  });

  let affected_codes = [code];
  if(req.body.apply_factor_prefix && req.body.factor !== undefined){
    const prefix = codePrefix(code);
    const factor = Math.max(1, num(req.body.factor) || 1);
    affected_codes = Object.keys(db.products).filter(k => codePrefix(k) === prefix);
    for(const k of affected_codes){
      db.products[k].factor = factor;
      db.products[k].updated_at = nowIso();
    }
    for(const storeId of Object.keys(db.draft_orders_by_store || {})){
      db.draft_orders_by_store[storeId] = normalizeOrderItems((db.draft_orders_by_store[storeId] || []).map(item => { if(codePrefix(item.code) === prefix) item.factor = factor; return item; }), db);
      db.order_history_by_store[storeId] = (db.order_history_by_store[storeId] || []).map(order => ({ ...order, items: normalizeOrderItems((order.items || []).map(item => { if(codePrefix(item.code) === prefix) item.factor = factor; return item; }), db) }));
    }
  }

  writeDb(db);
  res.json({ ok: true, product: db.products[code], affected_codes, message: `Alterações salvas. Fator aplicado em ${affected_codes.length} código(s).` });
});

app.post("/api/stock/import-many", authRequired, upload.array("files", 30), async (req,res)=>{
  if(!req.files || !req.files.length) return res.status(400).json({ error: "Arquivos não enviados" });
  const db = readDb();
  const summary = [];
  const beforeBase = Object.keys(db.products || {}).length;
  let totalImported = 0;
  try{
    for(const file of req.files){
      const parsed = await parseFile(file);
      const beforeFileBase = Object.keys(db.products || {}).length;
      for(const p of parsed.products) upsertProduct(db, p);
      const afterFileBase = Object.keys(db.products || {}).length;
      const mergedExisting = Math.max(0, parsed.products.length - (afterFileBase - beforeFileBase));
      db.stock_imports.unshift({
        file: file.originalname,
        imported_type: parsed.imported_type,
        imported_at: nowIso(),
        count: parsed.products.length,
        added_to_base: afterFileBase - beforeFileBase,
        merged_existing: mergedExisting
      });
      totalImported += parsed.products.length;
      summary.push({ file: file.originalname, imported_type: parsed.imported_type, count: parsed.products.length, added_to_base: afterFileBase - beforeFileBase, merged_existing: mergedExisting });
    }
    writeDb(db);
    const afterBase = Object.keys(db.products || {}).length;
    res.json({
      ok: true,
      total_files: req.files.length,
      total_imported: totalImported,
      total_added_to_base: afterBase - beforeBase,
      total_merged_existing: Math.max(0, totalImported - (afterBase - beforeBase)),
      total_in_base: afterBase,
      imports: summary
    });
  }catch(e){
    res.status(400).json({ error: e.message || "Falha ao importar arquivos" });
  }finally{
    for(const file of req.files){ if(file?.path) fs.unlink(file.path, ()=>{}); }
  }
});

app.get("/api/stock/imports", authRequired, (req,res)=>{
  const db = readDb();
  res.json({ imports: db.stock_imports || [] });
});

app.get("/api/orders/:storeId", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  ensureStore(db, storeId);
  db.draft_orders_by_store[storeId] = normalizeOrderItems(db.draft_orders_by_store[storeId], db);
  db.order_history_by_store[storeId] = (db.order_history_by_store[storeId] || []).map(order => ({ ...order, items: normalizeOrderItems(order.items, db) }));
  writeDb(db);
  res.json({ draft_items: db.draft_orders_by_store[storeId], history: db.order_history_by_store[storeId] });
});
app.put("/api/orders/:storeId", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  ensureStore(db, storeId);
  db.draft_orders_by_store[storeId] = normalizeOrderItems(req.body.items, db);
  db.orders_by_store[storeId] = db.draft_orders_by_store[storeId];
  writeDb(db);
  res.json({ ok: true, items: db.draft_orders_by_store[storeId] });
});
app.post("/api/orders/:storeId/finalize", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  ensureStore(db, storeId);
  const items = normalizeOrderItems(req.body.items, db);
  if(!items.length) return res.status(400).json({ error: "Pedido vazio" });
  const order = { order_number: nextOrderNumber(db, storeId), created_at: nowIso(), items };
  db.order_history_by_store[storeId].unshift(order);
  db.shortage_history_by_store[storeId].unshift({ order_number: order.order_number, created_at: order.created_at, items: items.map(x => ({ code:x.code, product:x.product, requested_units:x.units, left_in_stock:0, sent_to_truck:x.units })) });
  db.draft_orders_by_store[storeId] = [];
  db.orders_by_store[storeId] = [];
  writeDb(db);
  res.json({ ok: true, order });
});
app.get("/api/orders/:storeId/:orderNumber", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  const order = getOrderRecord(db, storeId, String(req.params.orderNumber||''));
  if(!order) return res.status(404).json({ error: "Ordem não encontrada" });
  res.json({ order: { ...order, items: normalizeOrderItems(order.items, db) } });
});
app.put("/api/orders/:storeId/:orderNumber", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  ensureStore(db, storeId);
  const order = getOrderRecord(db, storeId, String(req.params.orderNumber||''));
  if(!order) return res.status(404).json({ error: "Ordem não encontrada" });
  order.items = normalizeOrderItems(req.body.items, db);
  const shortage = getShortageRecord(db, storeId, order.order_number);
  if(shortage){
    const prev = Object.fromEntries((shortage.items||[]).map(x=>[x.code,x]));
    shortage.items = order.items.map(x => ({ code:x.code, product:x.product, requested_units:x.units, left_in_stock:num(prev[x.code]?.left_in_stock), sent_to_truck: Math.max(0, x.units - num(prev[x.code]?.left_in_stock)) }));
  }
  writeDb(db);
  res.json({ ok: true, order });
});
app.get("/api/orders/:storeId/pdf", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  const orderNumber = String(req.query.orderNumber || "");
  const items = orderExportRows(db, storeId, orderNumber);
  const storeName = db.stores[storeId] || `Loja ${storeId}`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="ordem-pedido-${orderNumber || storeId}.pdf"`);
  const pdf = new PDFDocument({ margin: 36, size: "A4" });
  pdf.pipe(res);
  pdf.fontSize(16).text("Ordem de Pedido", { align: "center" });
  pdf.moveDown(0.5).fontSize(11).text(`Loja: ${storeName} (${storeId})`);
  pdf.text(`Ordem: ${orderNumber}`);
  pdf.text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`);
  pdf.moveDown();
  pdf.fontSize(10);
  items.forEach((item)=> pdf.text(`${item.Item}. ${item.Código} - ${item.Produto} | Caixas: ${item.Caixas} | Unidades: ${item.Unidades} | Status: ${item.Status}`));
  pdf.end();
});
app.get("/api/orders/:storeId/word", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  const orderNumber = String(req.query.orderNumber || "");
  const storeName = db.stores[storeId] || `Loja ${storeId}`;
  const items = orderExportRows(db, storeId, orderNumber);
  const rows = items.map(item => `<tr><td>${item.Item}</td><td>${item.Código}</td><td>${item.Produto}</td><td>${item.Caixas}</td><td>${item.Unidades}</td><td>${item.Estoque}</td><td>${item.Status}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial}table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:6px;text-align:left}</style></head><body><h2>Ordem de Pedido</h2><p>Loja: ${storeName} (${storeId})<br>Ordem: ${orderNumber}<br>Gerado em: ${new Date().toLocaleString("pt-BR")}</p><table><thead><tr><th>#</th><th>Código</th><th>Produto</th><th>Caixas</th><th>Unidades</th><th>Estoque</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ordem-pedido-${orderNumber || storeId}.doc"`);
  res.send(html);
});
app.get("/api/orders/:storeId/excel", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  const orderNumber = String(req.query.orderNumber || "");
  const items = orderExportRows(db, storeId, orderNumber);
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(items);
  xlsx.utils.book_append_sheet(wb, ws, "Pedido");
  const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="ordem-pedido-${orderNumber || storeId}.xlsx"`);
  res.send(buffer);
});

app.get("/api/shortages/:storeId", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  ensureStore(db, storeId);
  res.json({ history: db.shortage_history_by_store[storeId] || [] });
});
app.put("/api/shortages/:storeId/:orderNumber", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  ensureStore(db, storeId);
  let record = getShortageRecord(db, storeId, String(req.params.orderNumber||''));
  if(!record) return res.status(404).json({ error: "Falta não encontrada" });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  record.items = items.map(x => ({
    code: String(x.code || "").trim().toUpperCase(),
    product: String(x.product || "").trim(),
    left_in_stock: num(x.left_in_stock),
    sent_to_truck: num(x.sent_to_truck),
    requested_units: num(x.requested_units)
  }));
  writeDb(db);
  res.json({ ok: true, items: record.items });
});
app.post("/api/separation/apply/:storeId/:orderNumber", authRequired, (req,res)=>{
  const db = readDb();
  const storeId = String(req.params.storeId || "01").padStart(2, "0");
  ensureStore(db, storeId);
  const record = getShortageRecord(db, storeId, String(req.params.orderNumber||''));
  if(!record) return res.status(404).json({ error: "Falta não encontrada" });
  for(const item of record.items || []){
    const p = db.products[item.code];
    if(!p) continue;
    p.stock = Math.max(0, num(p.stock) - num(item.sent_to_truck));
    p.updated_at = nowIso();
  }
  writeDb(db);
  res.json({ ok: true });
});

app.listen(PORT, ()=> console.log(`Servidor rodando na porta ${PORT}`));
