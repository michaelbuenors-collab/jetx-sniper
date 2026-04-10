const express=require('express');
const session=require('express-session');
const bcrypt=require('bcryptjs');
const http=require('http');
const path=require('path');
const {WebSocketServer,WebSocket}=require('ws');
const {v4:uuidv4}=require('uuid');
const fetch=require('node-fetch');

const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({server});

const users=[{id:'admin-001',username:'admin',password:bcrypt.hashSync('admin123',10),plan:'admin',active:true,expiresAt:null}];
let multipliers=[];
let rtpData={totalBet:0,totalPaid:0,retained:0,roundCount:0,rtpReal:97,rtpExpected:97,pressure:0};
const wsClients=new Map();

app.use(require('cors')({origin:true,credentials:true}));
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({secret:'jetx2024secret',resave:false,saveUninitialized:false,cookie:{secure:false,maxAge:86400000}}));
app.use(express.static(path.join(__dirname,'public')));

function auth(req,res,next){
  if(!req.session.uid)return res.status(401).json({error:'Não autenticado'});
  const u=users.find(u=>u.id===req.session.uid);
  if(!u||!u.active)return res.status(401).json({error:'Inativo'});
  req.user=u;
  next();
}

// ==========================================
// PROXY DA VAI DE BET
// ==========================================
app.get('/vaidebet',auth,(req,res)=>{
  // Página que embute a Vai de Bet com script de captura injetado
  const html=`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JetX - Vai de Bet</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#000;overflow:hidden;}
  #hud{
    position:fixed;top:10px;right:10px;z-index:99999;
    background:rgba(0,0,0,0.9);border:2px solid #f0c040;
    border-radius:10px;padding:8px 12px;font-family:Arial;
    font-size:12px;color:white;min-width:150px;
  }
  #hud h3{color:#f0c040;font-size:13px;margin-bottom:4px;}
  #frame-container{width:100vw;height:100vh;}
  #jetframe{width:100%;height:100%;border:none;}
  #overlay{
    position:fixed;bottom:0;left:0;right:0;
    background:rgba(0,0,0,0.95);border-top:2px solid #f0c040;
    padding:8px;display:flex;gap:8px;align-items:center;
    font-family:Arial;font-size:11px;color:white;
    overflow-x:auto;white-space:nowrap;
  }
  .mult{
    display:inline-block;padding:3px 8px;border-radius:5px;
    background:#1a2035;font-weight:bold;font-size:12px;
  }
  .mult.high{color:#f0c040;}
  .mult.mid{color:#4f4;}
  .mult.low{color:#f44;}
</style>
</head>
<body>

<div id="hud">
  <h3>⚡ JetX Sniper</h3>
  <div id="status">🔴 Aguardando...</div>
  <div>Rodadas: <b id="count" style="color:#f0c040">0</b></div>
  <div>Último: <b id="last" style="color:#4f4">--</b></div>
</div>

<div id="overlay">
  <span style="color:#f0c040;font-weight:bold">HISTÓRICO:</span>
  <span id="history-strip">aguardando dados...</span>
</div>

<div id="frame-container">
  <iframe id="jetframe" 
    src="https://m.vaidebet.bet.br/ptb/games/casino/detail/normal/13477"
    allow="autoplay; fullscreen"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals">
  </iframe>
</div>

<script>
const RAILWAY = 'https://jetx-sniper-production.up.railway.app';
const TOKEN = 'jetx2024';
let count = 0;
let history = [];

function updateHUD(connected, multiplier) {
  if(connected !== undefined) {
    document.getElementById('status').textContent = connected ? '🟢 CONECTADO' : '🔴 Aguardando...';
  }
  if(multiplier !== undefined) {
    count++;
    document.getElementById('count').textContent = count;
    document.getElementById('last').textContent = multiplier + 'x';
    history.unshift(multiplier);
    if(history.length > 20) history.pop();
    updateStrip();
  }
}

function updateStrip() {
  const strip = document.getElementById('history-strip');
  strip.innerHTML = history.map(m => {
    const cls = m >= 10 ? 'high' : m >= 2 ? 'mid' : 'low';
    return '<span class="mult ' + cls + '">' + m + 'x</span>';
  }).join(' ');
}

function sendToServer(multiplier) {
  fetch(RAILWAY + '/api/push', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({token: TOKEN, multiplier: multiplier})
  }).then(() => {
    updateHUD(undefined, multiplier);
  }).catch(e => console.log('Erro:', e));
}

// Intercepta mensagens do iframe
window.addEventListener('message', function(e) {
  try {
    const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if(d && d.jetx_result) {
      updateHUD(true, d.jetx_result);
      sendToServer(d.jetx_result);
    }
  } catch(ex) {}
});

// Tenta interceptar o WebSocket do iframe via postMessage
const iframe = document.getElementById('jetframe');
iframe.addEventListener('load', function() {
  updateHUD(true);
  console.log('iframe carregado');
  
  // Injeta script no iframe via postMessage (funciona se mesmo domínio)
  try {
    iframe.contentWindow.postMessage({type:'jetx_init'}, '*');
  } catch(e) {}
});

// Monitora a URL do iframe para detectar mudanças
setInterval(function() {
  try {
    const url = iframe.contentWindow.location.href;
    console.log('iframe url:', url);
  } catch(e) {}
}, 5000);

console.log('[JetX Sniper] Proxy ativo');
</script>
</body>
</html>`;
  res.send(html);
});

// ==========================================

app.post('/api/login',(req,res)=>{
  const{username,password}=req.body;
  const u=users.find(u=>u.username===username);
  if(!u||!bcrypt.compareSync(password,u.password))return res.status(401).json({error:'Incorreto'});
  req.session.uid=u.id;
  res.json({ok:true,user:{id:u.id,username:u.username,plan:u.plan}});
});

app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json({id:req.user.id,username:req.user.username,plan:req.user.plan}));
app.get('/api/data',auth,(req,res)=>res.json({multipliers,rtpData}));
app.get('/api/status',(req,res)=>res.json({roundCount:multipliers.length}));

app.post('/api/push',(req,res)=>{
  const{token,multiplier}=req.body;
  if(token!=='jetx2024')return res.status(403).json({error:'Token invalido'});
  const m=parseFloat(multiplier);
  if(isNaN(m)||m<1)return res.status(400).json({error:'Invalido'});
  multipliers.unshift(m);
  if(multipliers.length>1000)multipliers.pop();
  rtpData.roundCount++;
  broadcast({type:'new_round',multiplier:m,rtpData,multipliers:multipliers.slice(0,100)});
  res.json({ok:true});
});

app.get('/api/admin/users',auth,(req,res)=>{
  if(req.user.plan!=='admin')return res.status(403).json({error:'Proibido'});
  res.json(users.map(u=>({id:u.id,username:u.username,plan:u.plan,active:u.active,expiresAt:u.expiresAt})));
});

app.post('/api/admin/users',auth,(req,res)=>{
  if(req.user.plan!=='admin')return res.status(403).json({error:'Proibido'});
  const{username,password,plan,days}=req.body;
  if(!username||!password)return res.status(400).json({error:'Dados incompletos'});
  if(users.find(u=>u.username===username))return res.status(400).json({error:'Ja existe'});
  const expiresAt=days?new Date(Date.now()+days*86400000).toISOString():null;
  const u={id:uuidv4(),username,password:bcrypt.hashSync(password,10),plan:plan||'basic',active:true,expiresAt};
  users.push(u);
  res.json({ok:true});
});

app.put('/api/admin/users/:id',auth,(req,res)=>{
  if(req.user.plan!=='admin')return res.status(403).json({error:'Proibido'});
  const u=users.find(u=>u.id===req.params.id);
  if(!u)return res.status(404).json({error:'Nao encontrado'});
  const{active,plan,days,newPassword}=req.body;
  if(active!==undefined)u.active=active;
  if(plan)u.plan=plan;
  if(days)u.expiresAt=new Date(Date.now()+days*86400000).toISOString();
  if(newPassword)u.password=bcrypt.hashSync(newPassword,10);
  res.json({ok:true});
});

app.delete('/api/admin/users/:id',auth,(req,res)=>{
  if(req.user.plan!=='admin')return res.status(403).json({error:'Proibido'});
  const i=users.findIndex(u=>u.id===req.params.id);
  if(i===-1)return res.status(404).json({error:'Nao encontrado'});
  users.splice(i,1);
  res.json({ok:true});
});

wss.on('connection',(ws)=>{
  ws.on('message',(msg)=>{
    try{
      const d=JSON.parse(msg);
      if(d.type==='auth'){
        const u=users.find(u=>u.id===d.userId&&u.active);
        if(u){
          ws.uid=u.id;
          wsClients.set(u.id,ws);
          ws.send(JSON.stringify({type:'auth_ok',username:u.username}));
          ws.send(JSON.stringify({type:'init',multipliers,rtpData}));
        }
      }else if(d.type==='ping'){
        ws.send(JSON.stringify({type:'pong'}));
      }
    }catch(e){}
  });
  ws.on('close',()=>{if(ws.uid)wsClients.delete(ws.uid);});
});

function broadcast(data){
  const msg=JSON.stringify(data);
  wsClients.forEach(ws=>{if(ws.readyState===1)ws.send(msg);});
}

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('JetX Sniper rodando na porta '+PORT));
