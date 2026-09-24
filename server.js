
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DB_FILE = path.join(__dirname, "data.json");
const SESSION_DAYS = 7;
const FREE_REQUESTS = Number(process.env.FREE_REQUESTS || 30);
const MAX_BODY = 100000;

if (!OPENAI_API_KEY) console.warn("WARNING: OPENAI_API_KEY is not configured.");

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return {users: [], usage: {}}; }
}
let db = loadDB();
function saveDB() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}
function id(bytes=24){ return crypto.randomBytes(bytes).toString("hex"); }
function hashPassword(password, salt=id(16)) {
  return new Promise((resolve,reject)=>crypto.scrypt(password, Buffer.from(salt,"hex"), 64, (e,dk)=>{
    if(e) reject(e); else resolve(salt+":"+dk.toString("hex"));
  }));
}
function verifyPassword(password, stored) {
  return new Promise((resolve,reject)=>{
    const [salt,hash]=String(stored).split(":");
    if(!salt||!hash) return resolve(false);
    crypto.scrypt(password, Buffer.from(salt,"hex"), 64, (e,dk)=>{
      if(e) return reject(e);
      const a=Buffer.from(hash,"hex"), b=dk;
      resolve(a.length===b.length && crypto.timingSafeEqual(a,b));
    });
  });
}
function cookies(req) {
  const out={};
  (req.headers.cookie||"").split(";").forEach(x=>{
    const i=x.indexOf("="); if(i>0) out[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1).trim());
  });
  return out;
}
const sessions = new Map(); // token -> {userId, expires}
function userFromReq(req) {
  const token=cookies(req).mks_session;
  if(!token) return null;
  const s=sessions.get(token);
  if(!s || s.expires<Date.now()){ sessions.delete(token); return null; }
  return db.users.find(u=>u.id===s.userId)||null;
}
function setSession(res,userId) {
  const token=id(32);
  sessions.set(token,{userId,expires:Date.now()+SESSION_DAYS*864e5});
  const secure = process.env.NODE_ENV==="production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `mks_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS*86400}${secure}`);
}
function clearSession(res) {
  const token = cookies({headers:{cookie:res._reqCookie||""}}).mks_session;
  if(token) sessions.delete(token);
  res.setHeader("Set-Cookie","mks_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}
function json(res,status,obj,extra={}) {
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...extra});
  res.end(JSON.stringify(obj));
}
function html(res,body) {
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let body="";
    req.on("data",c=>{body+=c;if(body.length>MAX_BODY){req.destroy();reject(new Error("Request too large"));}});
    req.on("end",()=>{try{resolve(JSON.parse(body||"{}"))}catch{reject(new Error("Invalid JSON"))}});
    req.on("error",reject);
  });
}
function cleanEmail(e){return String(e||"").trim().toLowerCase();}
function usageFor(userId) {
  const month=new Date().toISOString().slice(0,7);
  if(!db.usage[userId] || db.usage[userId].month!==month) db.usage[userId]={month,count:0};
  return db.usage[userId];
}
function safeUser(u) {
  return {id:u.id,name:u.name,email:u.email,plan:u.plan,role:u.role,requestsUsed:usageFor(u.id).count,requestLimit:u.role==="admin"?"unlimited":u.monthlyLimit};
}
function modePrompt(mode) {
  const common=`You are MKS AI Public, a helpful multilingual assistant. Reply in Hindi/Hinglish when the user uses Hindi/Hinglish. Be accurate, practical and structured. Do not invent current facts, prices or legal requirements.`;
  const m={
    general:"Help with everyday questions and problem solving.",
    youtube:"YouTube expert. Create Shorts/long videos, hooks, scripts, titles, descriptions, English hashtags, tags, thumbnail prompts and 9:16 visual prompts.",
    advertising:"Outdoor advertising expert. Help with hoardings, billboards, unipoles, LED, signage, media plans, quotations, proposals and client communication. Mark pricing assumptions clearly.",
    business:"Business assistant for proposals, quotations, SOPs, company profiles, sales and client communication.",
    social:"Social media assistant for posts, captions, calendars, reels and CTAs.",
    writing:"Professional writing assistant for letters, emails, applications, speeches and polished Hindi/English copy.",
    education:"Teaching assistant for explanations, notes, quizzes and MCQs.",
    marketing:"Marketing assistant for campaign briefs, content plans, ad copy and KPIs.",
    prompts:"AI prompt engineer for image/video/writing prompts, including 9:16 when relevant.",
    translation:"Translation assistant preserving meaning, tone and formatting."
  };
  return common+" "+(m[mode]||m.general);
}
async function askOpenAI(message,mode){
  if(!OPENAI_API_KEY) throw new Error("AI service is not configured.");
  const r=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENAI_API_KEY}`},
    body:JSON.stringify({model:"gpt-5.6-luna",instructions:modePrompt(mode),input:message})
  });
  const data=await r.json();
  if(!r.ok) throw new Error(data.error?.message||"AI request failed");
  const text=(data.output||[]).flatMap(x=>Array.isArray(x.content)?x.content:[])
    .filter(x=>x.type==="output_text"&&typeof x.text==="string").map(x=>x.text).join("\n").trim();
  if(!text) throw new Error("No response text returned.");
  return text;
}

const index = fs.readFileSync(path.join(__dirname,"index.html"),"utf8");
const rate = new Map();
function ip(req){return (req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown").split(",")[0].trim();}
function allowed(req){
  const k=ip(req), now=Date.now(), a=rate.get(k)||[];
  const b=a.filter(t=>now-t<60000); if(b.length>=20) return false;
  b.push(now); rate.set(k,b); return true;
}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==="GET" && req.url==="/"){return html(res,index);}
    if(req.method==="GET" && req.url==="/api/me"){
      const u=userFromReq(req); return json(res,200,{user:u?safeUser(u):null});
    }
    if(req.method==="POST" && req.url==="/api/signup"){
      if(!allowed(req)) return json(res,429,{error:"Too many requests. Try again later."});
      const b=await readBody(req), name=String(b.name||"").trim(), email=cleanEmail(b.email), password=String(b.password||"");
      if(name.length<2||name.length>80) return json(res,400,{error:"Name must be 2-80 characters."});
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,400,{error:"Enter a valid email."});
      if(password.length<8) return json(res,400,{error:"Password must be at least 8 characters."});
      if(db.users.some(u=>u.email===email)) return json(res,409,{error:"An account with this email already exists."});
      const passHash=await hashPassword(password);
      const u={id:id(),name,email,passwordHash:passHash,plan:"free",role:(ADMIN_EMAIL&&email===ADMIN_EMAIL)?"admin":"user",monthlyLimit:FREE_REQUESTS,createdAt:new Date().toISOString()};
      db.users.push(u); saveDB(); setSession(res,u.id); return json(res,200,{user:safeUser(u)});
    }
    if(req.method==="POST" && req.url==="/api/login"){
      if(!allowed(req)) return json(res,429,{error:"Too many requests. Try again later."});
      const b=await readBody(req), email=cleanEmail(b.email), password=String(b.password||"");
      const u=db.users.find(x=>x.email===email);
      if(!u || !(await verifyPassword(password,u.passwordHash))) return json(res,401,{error:"Invalid email or password."});
      setSession(res,u.id); return json(res,200,{user:safeUser(u)});
    }
    if(req.method==="POST" && req.url==="/api/logout"){
      const token=cookies(req).mks_session; if(token) sessions.delete(token);
      return json(res,200,{ok:true},{ "Set-Cookie":"mks_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"});
    }
    if(req.method==="POST" && req.url==="/api/chat"){
      if(!allowed(req)) return json(res,429,{error:"Too many requests. Please wait a minute."});
      const u=userFromReq(req); if(!u) return json(res,401,{error:"Please log in first."});
      const b=await readBody(req), message=String(b.message||"").trim(), mode=String(b.mode||"general");
      if(!message) return json(res,400,{error:"Message required."});
      const usage=usageFor(u.id);
      if(u.role!=="admin" && usage.count>=u.monthlyLimit) return json(res,429,{error:`Monthly free limit reached (${u.monthlyLimit} requests).`});
      const answer=await askOpenAI(message,mode);
      usage.count++; saveDB();
      return json(res,200,{answer,usage:{used:usage.count,limit:u.role==="admin"?null:u.monthlyLimit}});
    }
    if(req.method==="GET" && req.url==="/api/admin/stats"){
      const u=userFromReq(req); if(!u||u.role!=="admin") return json(res,403,{error:"Admin only."});
      return json(res,200,{users:db.users.length,usage:Object.values(db.usage).reduce((n,x)=>n+x.count,0),
        recent:db.users.slice(-20).map(safeUser)});
    }
    return json(res,404,{error:"Not found"});
  }catch(e){console.error(e); return json(res,500,{error:e.message||"Server error"});}
});
server.listen(PORT,()=>console.log(`MKS AI Public running at http://localhost:${PORT}`));
