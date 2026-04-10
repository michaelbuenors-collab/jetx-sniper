const express=require('express');
const session=require('express-session');
const bcrypt=require('bcryptjs');
const http=require('http');
const path=require('path');
const {WebSocketServer}=require('ws');
const {v4:uuidv4}=require('uuid');

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

app.post('/api/push',(req,res)=>{
  const{token,multiplier,totalBet,totalPaid}=req.body;
  if(token!=='jetx2024')return res.status(403).json({error:'Token invalido'});
  const m=parseFloat(multiplier);
  if(isNaN(m)||m<1)return res.status(400).json({error:'Invalido'});
  multipliers.unshift(m);
  if(multipliers.length>1000)multipliers.pop();
  const tb=totalBet||0,tp=totalPaid||0;
  rtpData.totalBet+=tb;
  rtpData.totalPaid+=tp;
  rtpData.retained+=(tb-tp);
  rtpData.roundCount++;
  if(rtpData.totalBet>0)rtpData.rtpReal=(rtpData.totalPaid/rtpData.totalBet)*100;
  const exp=rtpData.totalBet*(1-rtpData.rtpExpected/100);
  rtpData.pressure=rtpData.retained-exp;
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
