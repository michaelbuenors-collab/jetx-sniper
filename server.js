const express=require('express');
const session=require('express-session');
const bcrypt=require('bcryptjs');
const http=require('http');
const path=require('path');
const {WebSocketServer,WebSocket}=require('ws');
const {v4:uuidv4}=require('uuid');

const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({server});

const users=[{id:'admin-001',username:'admin',password:bcrypt.hashSync('admin123',10),plan:'admin',active:true,expiresAt:null}];
let multipliers=[];
let rtpData={totalBet:0,totalPaid:0,retained:0,roundCount:0,rtpReal:97,rtpExpected:97,pressure:0};
const wsClients=new Map();

// ==========================================
// CONEXÃO AUTOMÁTICA COM SMARTSOFT / JETX
// ==========================================
let smartsoftWs=null;
let smartsoftConnected=false;
let reconnectTimer=null;

const SMARTSOFT_URL='wss://eu-server-w15.ssgportal.com/JetXNode728/signalr/connect?transport=webSockets&clientProtocol=1.5&group=JetX';

function connectSmartSoft(){
  console.log('[SmartSoft] Conectando...');
  try{
    smartsoftWs=new WebSocket(SMARTSOFT_URL,{
      headers:{
        'Origin':'https://vaidebet.com',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    smartsoftWs.on('open',()=>{
      console.log('[SmartSoft] Conectado!');
      smartsoftConnected=true;
      broadcast({type:'smartsoft_status',connected:true});
      // Envia ping para manter conexão viva
      setInterval(()=>{
        if(smartsoftWs&&smartsoftWs.readyState===WebSocket.OPEN){
          smartsoftWs.send(JSON.stringify({type:6})); // SignalR ping
        }
      },30000);
    });

    smartsoftWs.on('message',(data)=>{
      try{
        const raw=data.toString();
        // Ignora mensagens vazias ou apenas de controle SignalR
        if(!raw||raw==='{}'||raw==='[]')return;

        const msg=JSON.parse(raw);

        // SignalR handshake
        if(msg.C||msg.S){
          console.log('[SmartSoft] Handshake recebido');
          return;
        }

        // Mensagens do tipo M (data messages)
        if(msg.M&&Array.isArray(msg.M)){
          msg.M.forEach(m=>{
            if(m.M==='finish'||m.M==='roundResult'||m.M==='gameResult'){
              const args=m.A||[];
              let multiplier=null;

              // Tenta extrair o multiplicador de diferentes formatos
              if(args[0]&&args[0].result) multiplier=parseFloat(args[0].result);
              else if(args[0]&&args[0].multiplier) multiplier=parseFloat(args[0].multiplier);
              else if(args[0]&&args[0].crashPoint) multiplier=parseFloat(args[0].crashPoint);
              else if(typeof args[0]==='number') multiplier=args[0];
              else if(typeof args[1]==='number') multiplier=args[1];

              if(multiplier&&!isNaN(multiplier)&&multiplier>=1){
                console.log('[SmartSoft] Novo resultado: '+multiplier+'x');
                processNewMultiplier(multiplier);
              }
            }
          });
        }

        // Formato alternativo direto
        if(msg.result||msg.multiplier||msg.crashPoint){
          const m=parseFloat(msg.result||msg.multiplier||msg.crashPoint);
          if(!isNaN(m)&&m>=1){
            console.log('[SmartSoft] Resultado direto: '+m+'x');
            processNewMultiplier(m);
          }
        }

      }catch(e){
        // Ignora erros de parse silenciosamente
      }
    });

    smartsoftWs.on('error',(err)=>{
      console.log('[SmartSoft] Erro: '+err.message);
      smartsoftConnected=false;
      broadcast({type:'smartsoft_status',connected:false});
    });

    smartsoftWs.on('close',()=>{
      console.log('[SmartSoft] Desconectado. Reconectando em 5s...');
      smartsoftConnected=false;
      broadcast({type:'smartsoft_status',connected:false});
      clearTimeout(reconnectTimer);
      reconnectTimer=setTimeout(connectSmartSoft,5000);
    });

  }catch(e){
    console.log('[SmartSoft] Falha ao conectar: '+e.message);
    clearTimeout(reconnectTimer);
    reconnectTimer=setTimeout(connectSmartSoft,5000);
  }
}

function processNewMultiplier(m){
  multipliers.unshift(m);
  if(multipliers.length>1000)multipliers.pop();
  rtpData.roundCount++;
  broadcast({type:'new_round',multiplier:m,rtpData,multipliers:multipliers.slice(0,100),auto:true});
}

// Inicia conexão com SmartSoft ao subir o servidor
connectSmartSoft();

// ==========================================

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
app.get('/api/status',(req,res)=>res.json({smartsoftConnected,roundCount:multipliers.length}));

app.post('/api/push',(req,res)=>{
  const{token,multiplier,totalBet,totalPaid}=req.body;
  if(token!=='jetx2024')return res.status(403).json({error:'Token invalido'});
  const m=parseFloat(multiplier);
  if(isNaN(m)||m<1)return res.status(400).json({error:'Invalido'});
  processNewMultiplier(m);
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
          ws.send(JSON.stringify({type:'init',multipliers,rtpData,smartsoftConnected}));
        }
      } else if(d.type==='ping'){
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
