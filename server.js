const express=require('express');
const session=require('express-session');
const bcrypt=require('bcryptjs');
const {WebSocketServer}=require('ws');
const cors=require('cors');
const {v4:uuidv4}=require('uuid');
const http=require('http');
const path=require('path');
const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({server});
const DB={users:[{id:'admin-001',username:'admin',password:bcrypt.hashSync('admin123',10),plan:'admin',active:true,createdAt:new Date().toISOString(),expiresAt:null}],multipliers:[],rounds:[],rtpData:{totalBet:0,totalPaid:0,retained:0,roundCount:0,rtpReal:97,rtpExpected:97,pressure:0},scraperStatus:{connected:false,lastCapture:null,totalCaptures:0}};
app.use(cors({origin:true,credentials:true}));
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({secret:'jetx-sniper-2024',resave:false,saveUninitialized:false,cookie:{secure:false,maxAge:86400000}}));
app.use(express.static(path.join(__dirname,'public')));
function auth(req,res,next){if(!req.session.userId)return res.status(401).json({error:'Não autenticado'});const u=DB.users.find(u=>u.id===req.session.userId);if(!u||!u.active)return res.status(401).json({error:'Inativo'});req.user=u;next();}
app.post('/api/login',(req,res)=>{const{username,password}=req.body;const u=DB.users.find(u=>u.username===username);if(!u||!bcrypt.compareSync(password,u.password))return res.status(401).json({error:'Incorreto'});req.session.userId=u.id;res.json({ok:true,user:{id:u.id,username:u.username,plan:u.plan}});});
app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json({id:req.user.id,username:req.user.username,plan:req.user.plan}));
app.get('/api/data',auth,(req,res)=>res.json({multipliers:DB.multipliers,rtpData:DB.rtpData,scraperStatus:DB.scraperStatus}));
app.post('/api/push',(req,res)=>{const{token,multiplier,totalBet,totalPaid}=req.body;if(token!=='jetx2024')return res.status(403).json({error:'Token inválido'});if(!multiplier||multiplier<1)return res.status(400).json({error:'Inválido'});DB.multipliers.unshift(parseFloat(multiplier));if(DB.multipliers.length>1000)DB.multipliers.pop();DB.rtpData.totalBet+=totalBet||0;DB.rtpData.totalPaid+=totalPaid||0;DB.rtpData.retained+=(totalBet||0)-(totalPaid||0);DB.rtpData.roundCount++;if(DB.rtpData.totalBet>0)DB.rtpData.rtpReal=(DB.rtpData.totalPaid/DB.rtpData.totalBet)*100;const exp=DB.rtpData.totalBet*(1-DB.rtpData.rtpExpected/100);DB.rtpData.pressure=DB.rtpData.retained-exp;DB.scraperStatus.connected=true;DB.scraperStatus.lastCapture=Date.now();DB.scraperStatus.totalCaptures++;broadcastToAll({type:'new_round',multiplier:parseFloat(multiplier),totalBet:totalBet||0,totalPaid:totalPaid||0,rtpData:DB.rtpData,multipliers:DB.multipliers.slice(0,100)});res.json({ok:true});});
app.get('/api/admin/users',auth,(req,res)=>{if(req.user.plan!=='admin')return res.status(403).json({error:'Sem permissão'});res.json(DB.users.map(u=>({id:u.id,username:u.username,plan:u.plan,active:u.active,expiresAt:u.expiresAt})));});
app.post('/api/admin/users',auth,(req,res)=>{if(req.user.plan!=='admin')return res.status(403).json({error:'Sem permissão'});const{username,password,plan,days}=req.body;if(!username||!password)return res.status(400).json({error:'Incompleto'});if(DB.users.find(u=>u.username===username))return res.status(400).json({error:'Já existe'});const expiresAt=days?new Date(Date.now()+days*86400000).toISOString():null;const u={id:uuidv4(),username,password:bcrypt.hashSync(password,10),plan:plan||'basic',active:true,createdAt:new Date().toISOString(),expiresAt};DB.users.push(u);res.json({ok:true});});
app.put('/api/admin/users/:id',auth,(req,res)=>{if(req.user.plan!=='admin')return res.status(403).json({error:'Sem permissão'});const u=DB.users.find(u=>u.id===req.params.id);if(!u)return res.status(404).json({error:'Não encontrado'});const{active,plan,days,newPassword}=req.body;if(active!==undefined)u.active=active;if(plan)u.plan=plan;if(days)u.expiresAt=new Date(Date.now()+days*86400000).toISOString();if(newPassword)u.password=bcrypt.hashSync(newPassword,10);res.json({ok:true});});
app.delete('/api/admin/users/:id',auth,(req,res)=>{if(req.user.plan!=='admin')return res.status(403).json({error:'Sem permissão'});const idx=DB.users.findIndex(u=>u.id===req.params.id);if(idx===-1)return res.status(404).json({error:'Não encontrado'});DB.users.splice(idx,1);res.json({ok:true});});
const wsClients=new Map();
wss.on('connection',(ws)=>{ws.isAlive=true;ws.on('message',(msg)=>{try{const d=JSON.parse(msg);if(d.type==='auth'){const u=DB.users.find(u=>u.id===d.userId&&u.active);if(u){ws.userId=u.id;wsClients.set(u.id,ws);ws.send(JSON.stringify({type:'auth_ok',username:u.username}));ws.send(JSON.stringify({type:'init',multipliers:DB.multipliers,rtpData:DB.rtpData,scraperStatus:DB.scraperStatus}));}}else if(d.type==='ping'){ws.isAlive=true;ws.send(JSON.stringify({type:'pong'}));}}catch(e){}});ws.on('close',()=>{if(ws.userId)wsClients.delete(ws.userId);});ws.on('pong',()=>{ws.isAlive=true;});});
function broadcastToAll(data){const msg=JSON.stringify(data);wsClients.forEach((ws)=>{if(ws.readyState===1)ws.send(msg);});}
setInterval(()=>{wss.clients.forEach(ws=>{if(!ws.isAlive)return ws.terminate();ws.isAlive=false;ws.ping();});},30000);
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`JetX Sniper
