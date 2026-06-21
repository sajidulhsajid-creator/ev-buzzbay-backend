const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('\n================================================');
console.log('EV CHARGING NETWORK - BOOKING SYSTEM');
console.log('================================================');

// CORS Configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Sample chargers data (in-memory for reliability)
const chargers = [
  {
    id: 'locationA',
    name: 'Charging Station A',
    location: 'West Footscray Center',
    maxPower: 7.4,
    state: { state: '0x02', current: 0, temperature: 25, pilot: 16, rssi: 85, status: 'online' }
  },
  {
    id: 'locationB',
    name: 'Charging Station B',
    location: 'Railway Station Area',
    maxPower: 11,
    state: { state: '0x02', current: 0, temperature: 24, pilot: 16, rssi: 90, status: 'online' }
  },
  {
    id: 'locationC',
    name: 'Charging Station C',
    location: 'Car Park',
    maxPower: 7.4,
    state: { state: '0x02', current: 0, temperature: 23, pilot: 16, rssi: 88, status: 'online' }
];

// In-memory bookings
let bookings = [];
let bookingId = 1;

// Routes

// Home
app.get('/', (req, res) => {
  try {
    res.json({
      name: 'EV Charging Booking System',
      version: '1.0.0',
      status: 'running',
      endpoints: {
        chargers: '/api/chargers',
        bookings: '/api/bookings',
        health: '/health'
      }
    });
  } catch (err) {
    console.error('[Error] GET /:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  try {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      chargers: chargers.length
    });
  } catch (err) {
    console.error('[Error] GET /health:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get all chargers
app.get('/api/chargers', (req, res) => {
  try {
    console.log('[API] GET /api/chargers - returning', chargers.length, 'chargers');
    res.json({
      success: true,
      data: chargers
    });
  } catch (err) {
    console.error('[Error] GET /api/chargers:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get specific charger
app.get('/api/chargers/:locationId', (req, res) => {
  try {
    const { locationId } = req.params;
    const charger = chargers.find(c => c.id === locationId);
    
    if (!charger) {
      return res.status(404).json({ success: false, error: 'Charger not found' });
    }
    
    res.json({ success: true, data: charger });
  } catch (err) {
    console.error('[Error] GET /api/chargers/:locationId:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update charger
app.post('/api/update-charger', (req, res) => {
  try {
    const { locationId, state, current, temperature, rssi } = req.body;
    
    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId required' });
    }
    
    const charger = chargers.find(c => c.id === locationId);
    if (!charger) {
      return res.status(404).json({ success: false, error: 'Charger not found' });
    }
    
    // Update charger data
    if (state) charger.state.state = state;
    if (current !== undefined) charger.state.current = current;
    if (temperature !== undefined) charger.state.temperature = temperature;
    if (rssi !== undefined) charger.state.rssi = rssi;
    charger.state.status = 'online';
    
    console.log('[API] Updated charger:', locationId);
    res.json({ success: true, message: 'Charger updated', data: charger });
  } catch (err) {
    console.error('[Error] POST /api/update-charger:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get availability
app.get('/api/availability/:locationId/:date', (req, res) => {
  try {
    const { locationId, date } = req.params;
    
    const chargerBookings = bookings.filter(b => 
      b.locationId === locationId && 
      new Date(b.startTime).toDateString() === new Date(date).toDateString()
    );
    
    res.json({ success: true, bookings: chargerBookings });
  } catch (err) {
    console.error('[Error] GET /api/availability:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Estimate charging time
app.post('/api/estimate', (req, res) => {
  try {
    const { chargerPower, batteryCapacity, targetSOC, currentSOC } = req.body;
    
    if (!chargerPower || !batteryCapacity) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }
    
    const soc = currentSOC || 20;
    const target = targetSOC || 80;
    const energyNeeded = (batteryCapacity * (target - soc)) / 100;
    const chargingTime = Math.round((energyNeeded / chargerPower) * 60);
    
    res.json({ 
      success: true, 
      chargingTime, 
      energyNeeded: energyNeeded.toFixed(2)
    });
  } catch (err) {
    console.error('[Error] POST /api/estimate:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Create booking
app.post('/api/bookings', (req, res) => {
  try {
    const { userId, locationId, startTime, endTime, estimatedChargingTime, targetSOC, notes } = req.body;
    
    if (!locationId || !startTime || !endTime) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const booking = {
      id: bookingId++,
      userId: userId || 0,
      locationId,
      startTime,
      endTime,
      estimatedChargingTime: estimatedChargingTime || 60,
      targetSOC: targetSOC || 80,
      status: 'confirmed',
      notes: notes || '',
      createdAt: new Date().toISOString()
    };
    
    bookings.push(booking);
    console.log('[API] Created booking:', booking.id);
    
    res.json({
      success: true,
      message: 'Booking created',
      bookingId: booking.id,
      data: booking
    });
  } catch (err) {
    console.error('[Error] POST /api/bookings:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get all bookings
app.get('/api/bookings', (req, res) => {
  try {
    console.log('[API] GET /api/bookings - returning', bookings.length, 'bookings');
    res.json({ success: true, data: bookings });
  } catch (err) {
    console.error('[Error] GET /api/bookings:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get specific booking
app.get('/api/bookings/:bookingId', (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = bookings.find(b => b.id === parseInt(bookingId));
    
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    res.json({ success: true, data: booking });
  } catch (err) {
    console.error('[Error] GET /api/bookings/:bookingId:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update booking
app.patch('/api/bookings/:bookingId', (req, res) => {
  try {
    const { bookingId } = req.params;
    const { status, notes } = req.body;
    
    const booking = bookings.find(b => b.id === parseInt(bookingId));
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    
    if (status) booking.status = status;
    if (notes) booking.notes = notes;
    
    console.log('[API] Updated booking:', bookingId);
    res.json({ success: true, message: 'Booking updated', data: booking });
  } catch (err) {
    console.error('[Error] PATCH /api/bookings/:bookingId:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] CORS enabled for all origins`);
  console.log(`[Server] ${chargers.length} chargers loaded`);
  console.log('\n✅ Booking API ready!');
});

server.on('error', (err) => {
  console.error('[Server Error]', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
