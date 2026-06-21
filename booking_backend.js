const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('\n================================================');
console.log('EV CHARGING NETWORK - BOOKING SYSTEM');
console.log('================================================');

app.use(cors());
app.use(bodyParser.json());

const chargers = [
  { id: 'locationA', name: 'Charging Station A', location: 'West Footscray Center', maxPower: 7.4, state: { state: '0x02', current: 0, temperature: 25, pilot: 16, rssi: 85, status: 'online' } },
  { id: 'locationB', name: 'Charging Station B', location: 'Railway Station Area', maxPower: 11, state: { state: '0x02', current: 0, temperature: 24, pilot: 16, rssi: 90, status: 'online' } },
  { id: 'locationC', name: 'Charging Station C', location: 'Car Park', maxPower: 7.4, state: { state: '0x02', current: 0, temperature: 23, pilot: 16, rssi: 88, status: 'online' } }
];

let bookings = [];
let bookingId = 1;

app.get('/', (req, res) => {
  res.json({ name: 'EV Charging Booking System', status: 'running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/chargers', (req, res) => {
  res.json({ success: true, data: chargers });
});

app.get('/api/chargers/:locationId', (req, res) => {
  const charger = chargers.find(c => c.id === req.params.locationId);
  if (!charger) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: charger });
});

app.post('/api/update-charger', (req, res) => {
  const { locationId, state, current, temperature, rssi } = req.body;
  const charger = chargers.find(c => c.id === locationId);
  if (charger) {
    if (state) charger.state.state = state;
    if (current !== undefined) charger.state.current = current;
    if (temperature !== undefined) charger.state.temperature = temperature;
    if (rssi !== undefined) charger.state.rssi = rssi;
    charger.state.status = 'online';
  }
  res.json({ success: true, message: 'Updated' });
});

app.get('/api/availability/:locationId/:date', (req, res) => {
  const filtered = bookings.filter(b => b.locationId === req.params.locationId);
  res.json({ success: true, bookings: filtered });
});

app.post('/api/estimate', (req, res) => {
  const { chargerPower, batteryCapacity, targetSOC, currentSOC } = req.body;
  const soc = currentSOC || 20;
  const target = targetSOC || 80;
  const energyNeeded = (batteryCapacity * (target - soc)) / 100;
  const chargingTime = Math.round((energyNeeded / chargerPower) * 60);
  res.json({ success: true, chargingTime, energyNeeded: energyNeeded.toFixed(2) });
});

app.post('/api/bookings', (req, res) => {
  const { userId, locationId, startTime, endTime, estimatedChargingTime, targetSOC, notes } = req.body;
  const booking = { id: bookingId++, userId: userId || 0, locationId, startTime, endTime, estimatedChargingTime: estimatedChargingTime || 60, targetSOC: targetSOC || 80, status: 'confirmed', notes: notes || '', createdAt: new Date().toISOString() };
  bookings.push(booking);
  res.json({ success: true, message: 'Booking created', bookingId: booking.id, data: booking });
});

app.get('/api/bookings', (req, res) => {
  res.json({ success: true, data: bookings });
});

app.get('/api/bookings/:bookingId', (req, res) => {
  const booking = bookings.find(b => b.id === parseInt(req.params.bookingId));
  if (!booking) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: booking });
});

app.patch('/api/bookings/:bookingId', (req, res) => {
  const booking = bookings.find(b => b.id === parseInt(req.params.bookingId));
  if (booking) {
    if (req.body.status) booking.status = req.body.status;
    if (req.body.notes) booking.notes = req.body.notes;
  }
  res.json({ success: true, message: 'Updated' });
});

app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ success: false, error: 'Server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] CORS enabled`);
  console.log(`[Server] ${chargers.length} chargers loaded`);
  console.log('\n✅ Booking API ready!');
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
