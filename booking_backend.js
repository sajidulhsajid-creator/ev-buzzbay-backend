const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const chargers = [
  {id:'locationA',name:'Station A',location:'West Footscray',maxPower:7.4,state:{state:'0x02',current:0,temperature:25,pilot:16,rssi:85,status:'online'}},
  {id:'locationB',name:'Station B',location:'Railway Station',maxPower:11,state:{state:'0x02',current:0,temperature:24,pilot:16,rssi:90,status:'online'}},
  {id:'locationC',name:'Station C',location:'Car Park',maxPower:7.4,state:{state:'0x02',current:0,temperature:23,pilot:16,rssi:88,status:'online'}}
];

let bookings = [];
let bid = 1;

app.get('/', (req, res) => res.json({status:'ok'}));
app.get('/health', (req, res) => res.json({status:'ok'}));
app.get('/api/chargers', (req, res) => res.json({success:true,data:chargers}));
app.get('/api/chargers/:id', (req, res) => {
  const c = chargers.find(x => x.id === req.params.id);
  res.json({success:!!c,data:c});
});

app.post('/api/update-charger', (req, res) => {
  const c = chargers.find(x => x.id === req.body.locationId);
  if(c && req.body.state) c.state.state = req.body.state;
  if(c && req.body.current !== undefined) c.state.current = req.body.current;
  if(c && req.body.temperature !== undefined) c.state.temperature = req.body.temperature;
  if(c && req.body.rssi !== undefined) c.state.rssi = req.body.rssi;
  res.json({success:true});
});

app.get('/api/availability/:loc/:date', (req, res) => {
  res.json({success:true,bookings:bookings.filter(b => b.locationId === req.params.loc)});
});

app.post('/api/estimate', (req, res) => {
  const {chargerPower, batteryCapacity, targetSOC, currentSOC} = req.body;
  const soc = currentSOC || 20;
  const target = targetSOC || 80;
  const energy = (batteryCapacity * (target - soc)) / 100;
  const time = Math.round((energy / chargerPower) * 60);
  res.json({success:true,chargingTime:time,energyNeeded:energy.toFixed(2)});
});

app.post('/api/bookings', (req, res) => {
  const b = {id:bid++,...req.body,status:'confirmed',createdAt:new Date().toISOString()};
  bookings.push(b);
  res.json({success:true,bookingId:b.id,data:b});
});

app.get('/api/bookings', (req, res) => res.json({success:true,data:bookings}));
app.get('/api/bookings/:id', (req, res) => {
  const b = bookings.find(x => x.id === parseInt(req.params.id));
  res.json({success:!!b,data:b});
});

app.patch('/api/bookings/:id', (req, res) => {
  const b = bookings.find(x => x.id === parseInt(req.params.id));
  if(b) {
    if(req.body.status) b.status = req.body.status;
    if(req.body.notes) b.notes = req.body.notes;
  }
  res.json({success:true});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on port ${PORT}`));
